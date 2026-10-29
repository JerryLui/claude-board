// The Missions view, the board's home page (`GET /`): a column per derived state with the
// queued shown under waiting, a card's Fire and Merge buttons only while a round on the
// mission's own board still asks for that answer, a click on one answering that round
// with option 0, Stop asked once and then posted as an order (a Cmd-click posts it at
// once), a note on a card posted as a comment order, and the columns re-read when the
// daemon-wide stream says a mission changed. Plus the question `action` field those buttons read, accepted and refused at
// post time.
//
// One layer: a real daemon on a temporary store and ephemeral port, the page it serves
// parsed by test/dom-stand-in.mjs, and the REAL indexScript run against it with its fetches
// sent to that daemon under the browser's session cookie (test/support.mjs's
// `loadIndexAgainstDaemon`, as test/check-index-live.mjs drives the boards list). What is
// asserted after a click is what the daemon stored, read back with the secret. Layout is
// test/browser-check-missions.mjs's, in a real Chrome.
//
// Rounds posted here wait on an answer and no board is ever opened, the stranded rule's
// shape: the PATH stub and the day-long grace keep any banner off the screen.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';
import { StandInEvent, fetchSettler, parseHTML } from './dom-stand-in.mjs';
import { check, deadPid, runMain, secretHome, writeStub, rawRequest, writeHeaders, pageHarness, postBoard } from './support.mjs';

const { loadIndexAgainstDaemon } = await pageHarness();

const { home: workDir, secret: SECRET } = secretHome('claude-board-missions-view-', { secret: 'f'.repeat(64), setHome: false });
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
process.env.CLAUDE_BOARD_HOME = home;
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(24 * 60 * 60 * 1000);
const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', '#!/bin/sh\nexit 0\n');
process.env.PATH = `${stubDir}:${process.env.PATH}`;

let port;
const settler = fetchSettler();

async function post(route, body) {
  const r = await rawRequest(port, 'POST', route, { headers: writeHeaders(SECRET), body: JSON.stringify(body) });
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}

async function mission(key) {
  const r = await rawRequest(port, 'GET', `/api/mission/${key}`, { headers: { [SECRET_HEADER]: SECRET } });
  assert.equal(r.status, 200, `setup: reading mission ${key}: ${r.body}`);
  return JSON.parse(r.body);
}

/** A mission with a session bound to `pid` (this process is alive for the whole file). */
async function liveMission(key, fields = {}) {
  assert.equal((await post(`/api/mission/${key}`, { title: key, phase: 'direct', state: 'working', ...fields })).status, 200);
  assert.equal((await post(`/api/mission/${key}/session`, { pid: process.pid, id: `sess-${key}` })).status, 200);
}

/** A round on `key`'s own board holding one question with `action`, beside an ordinary one. */
async function actionRound(key, action, labels) {
  const posted = await postBoard(port, SECRET, {
    title: `${key} board`,
    mission: key,
    blocks: [
      { kind: 'question', prompt: 'Go?', widget: 'single', action, options: labels.map(label => ({ label })) },
      { kind: 'question', prompt: 'Anything else?', widget: 'text' },
    ],
  });
  const board = readBoard(posted.boardId, home);
  const question = board.blocks.find(b => b.action === action);
  return { boardId: posted.boardId, round: question.round, questionId: question.id };
}

/** The served Missions page with the real indexScript running in it, its stream a stand-in
 * the check pushes real daemon events into. */
async function openMissionsTab() {
  const page = await rawRequest(port, 'GET', '/', { headers: { [SECRET_HEADER]: SECRET } });
  assert.equal(page.status, 200);
  const tab = loadIndexAgainstDaemon(port, { secret: SECRET, html: page.body, stream: true, settler });
  await settler.settle();
  return {
    document: tab.document,
    async push(name, data) {
      const listeners = tab.stream && tab.stream.listeners.get(name);
      assert.ok(listeners && listeners.length, `the Missions page must listen for '${name}' on the daemon-wide stream`);
      tab.stream.dispatch(name, JSON.stringify(data));
      await settler.settle();
    },
    async click(el) {
      assert.ok(el, 'setup: the element to click is on the page');
      el.dispatchEvent(new StandInEvent('click'));
      await settler.settle();
    },
    restoreFetch: tab.restoreFetch,
  };
}

const cardFor = (doc, key) => doc.querySelectorAll('article.mission-card').find(c => c.getAttribute('data-mission-key') === key) || null;
const actionButtons = card => card.querySelectorAll('button.mission-act').map(b => ({ kind: b.getAttribute('data-action'), label: b.textContent }));

/** Column name to the keys its cards carry, in order, for every column on the page. */
function columns(doc) {
  const out = {};
  for (const col of doc.querySelectorAll('section.mission-col')) {
    out[col.getAttribute('data-col')] = col.querySelectorAll('article.mission-card').map(c => c.getAttribute('data-mission-key')).sort();
  }
  return out;
}

/** A second subscriber on `GET /api/events`, so a push fed to the page is one the daemon
 * really sent (the shape test/check-index-live.mjs's own wire stream has). */
function openWireStream() {
  const events = [];
  let raw = '';
  let pending = '';
  // Each wait is re-tried on every chunk the stream delivers, so it resolves on the frame
  // itself; the timeout only bounds a stream that never sends it.
  const waits = new Set();
  const req = http.request({
    host: '127.0.0.1', port, method: 'GET', path: '/api/events',
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
      for (const wait of waits) wait();
    });
  });
  req.on('error', () => {});
  req.end();
  const until = (what, ready) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waits.delete(wait);
      reject(new Error(`${what} never arrived: ${JSON.stringify(raw)}`));
    }, 30_000);
    const wait = () => {
      const hit = ready();
      if (!hit) return;
      waits.delete(wait);
      clearTimeout(timer);
      resolve(hit);
    };
    waits.add(wait);
    wait();
  });
  return {
    connected: () => until('the stream connecting', () => raw.includes(': connected') || null),
    next: name => until(`a '${name}' event`, () => {
      const i = events.findIndex(e => e.name === name);
      return i === -1 ? null : events.splice(i, 1)[0];
    }),
    close() { req.destroy(); },
  };
}

async function main() {
  const started = await startServer({ home, port: 0 });
  const { server } = started;
  port = started.port;
  try {
    await check('a question carries action fire or merge on a single widget; any other value, or another widget, is refused', async () => {
      const ok = await postBoard(port, SECRET, { title: 'Action accepted', blocks: [
        { kind: 'question', prompt: 'Fire?', widget: 'single', action: 'fire', options: [{ label: 'Fire' }, { label: 'Not yet' }] },
        { kind: 'question', prompt: 'Merge?', action: 'merge', options: [{ label: 'Merge' }] },
        { kind: 'question', prompt: 'Plain?', widget: 'single', options: [{ label: 'Yes' }] },
      ] });
      const stored = readBoard(ok.boardId, home).blocks.map(b => b.action);
      assert.deepEqual(stored, ['fire', 'merge', undefined]);

      for (const [block, message] of [
        [{ kind: 'question', prompt: 'Deploy?', widget: 'single', action: 'deploy', options: [{ label: 'Yes' }] },
          'unknown question action: "deploy" (expected one of fire, merge)'],
        [{ kind: 'question', prompt: 'Fire?', widget: 'multi', action: 'fire', options: [{ label: 'Yes' }] },
          "question action 'fire' needs widget 'single', not 'multi'"],
      ]) {
        const r = await post('/api/board', { title: 'Action refused', blocks: [block] });
        assert.equal(r.status, 400);
        assert.equal(r.body.error, message);
      }
    });

    // The fixtures the rest of the file shares: one mission per column, and queued.
    await liveMission('WORKING_ONE');
    await liveMission('WORKING_TWO', { summary: 'Wave 2 of 3', waitingOn: 'checks on #12', next: 'merge',
      prs: [{ repo: 'service', number: 12, url: 'https://github.com/o/service/pull/12', state: 'green' }] });
    assert.equal((await post('/api/mission/WAITING_ONE', { title: 'Waiting one', state: 'waiting', phase: 'landing',
      prs: [{ repo: 'admin', number: 7, url: 'javascript:alert(1)', state: 'open' }] })).status, 200);
    assert.equal((await post('/api/mission/QUEUED_ONE', { title: 'Queued one', state: 'queued', phase: 'direct' })).status, 200);
    assert.equal((await post('/api/mission/RELEASED_ONE', { title: 'Released one', state: 'released', phase: 'landing' })).status, 200);
    assert.equal((await post('/api/mission/STALLED_ONE', { title: 'Stalled one', state: 'working', phase: 'direct' })).status, 200);
    assert.equal((await post('/api/mission/STALLED_ONE/session', { pid: await deadPid() })).status, 200);
    const needsBoard = await postBoard(port, SECRET, { title: 'Needs board', mission: 'NEEDS_ONE',
      blocks: [{ kind: 'question', prompt: 'Which?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }] });

    const expected = {
      'needs-you': ['NEEDS_ONE'],
      working: ['WORKING_ONE', 'WORKING_TWO'],
      waiting: ['QUEUED_ONE', 'WAITING_ONE'],
      stalled: ['STALLED_ONE'],
      released: ['RELEASED_ONE'],
    };

    await check('each mission shows in its derived state\'s column, queued under waiting, on first paint and once live', async () => {
      const page = await rawRequest(port, 'GET', '/', { headers: { [SECRET_HEADER]: SECRET } });
      const served = parseHTML(page.body);
      assert.deepEqual(columns(served), expected);
      assert.deepEqual(served.querySelectorAll('h2.mission-col-head span.mission-badge').map(n => n.textContent),
        ['Needs you', 'Working', 'Waiting', 'Stalled', 'Released'], 'the last column reads Released (ADR 130)');
      assert.equal(cardFor(served, 'QUEUED_ONE').querySelector('span.mission-tag').textContent, 'Queued');
      assert.equal(served.querySelector('p.empty-state'), null, 'no empty state once a mission exists');

      const tab = await openMissionsTab();
      try {
        assert.deepEqual(columns(tab.document), expected);
        const card = cardFor(tab.document, 'WORKING_TWO');
        assert.equal(card.querySelector('b.mission-title').textContent, 'WORKING_TWO');
        assert.equal(card.querySelector('span.mission-key').textContent, 'direct', 'a title that is the key is not said twice');
        assert.equal(cardFor(tab.document, 'WAITING_ONE').querySelector('span.mission-key').textContent, 'WAITING_ONE / landing');
        assert.equal(card.querySelector('p.mission-summary').textContent, 'Wave 2 of 3');
        assert.deepEqual(card.querySelectorAll('p.mission-fact').map(n => [n.querySelector('span.mission-label').textContent, n.textContent]),
          [['Waiting on', 'Waiting onchecks on #12'], ['Next', 'Nextmerge']]);
        const pr = card.querySelector('a.mission-pr');
        assert.equal(pr.getAttribute('href'), 'https://github.com/o/service/pull/12');
        assert.equal(pr.textContent, '✓service #12');
        const odd = cardFor(tab.document, 'WAITING_ONE').querySelector('.mission-pr');
        assert.deepEqual([odd.tagName, odd.getAttribute('href'), odd.textContent], ['SPAN', null, '○admin #7'],
          'a url that is not a web address is shown, never linked');
        const needs = cardFor(tab.document, 'NEEDS_ONE');
        assert.deepEqual([needs.querySelector('b.mission-title a.mission-link').getAttribute('href'), needs.getAttribute('tabindex')],
          [`/b/${needsBoard.boardId}`, null], 'the card\'s title is the link to the latest board the mission posted, the one stop for Tab');
        assert.equal(needs.querySelector('a.mission-btn'), null, 'no Open board button');
        assert.ok(cardFor(tab.document, 'WORKING_ONE').querySelector('button.mission-stop'), 'a live session offers Stop');
        assert.equal(cardFor(tab.document, 'STALLED_ONE').querySelector('button.mission-stop'), null, 'a stalled one does not');
        assert.equal(cardFor(tab.document, 'RELEASED_ONE').querySelector('button.mission-stop'), null);
      } finally {
        tab.restoreFetch();
      }
    });

    for (const [kind, label, labels] of [['fire', 'Fire', ['Fire /direct', 'Not yet']], ['merge', 'Merge', ['Merge both', 'Hold']]]) {
      await check(`${label} shows while the round asks for it, and a click answers that round with option 0${kind === 'fire' ? ', recorded on the mission as a card\'s Fire' : ', recording no Fire'}`, async () => {
        const key = `${kind.toUpperCase()}_CLICK`;
        await liveMission(key);
        const { boardId, round, questionId } = await actionRound(key, kind, labels);
        const tab = await openMissionsTab();
        try {
          const card = cardFor(tab.document, key);
          assert.deepEqual(actionButtons(card), [{ kind, label }]);
          assert.equal(card.querySelector('a.mission-link').getAttribute('href'), `/b/${boardId}`, 'the card opens the round waiting on the PM');
          assert.equal(card.querySelector('a.mission-btn'), null, 'no Open round button');
          await tab.click(card.querySelector('button.mission-act'));

          const board = readBoard(boardId, home);
          assert.equal(board.rounds.find(r => r.n === round).status, 'sent');
          assert.deepEqual(board.answers[questionId], { id: questionId, status: 'answered', choice: labels[0], note: '' });
          const { fire } = await mission(key);
          if (kind === 'fire') assert.equal(fire?.by, 'card', `the click records a card's Fire: ${JSON.stringify(fire)}`);
          else assert.equal(fire, undefined, 'a Merge records no Fire');
          assert.deepEqual(actionButtons(cardFor(tab.document, key)), [], 'the answered round offers the button no more');
          assert.equal(cardFor(tab.document, key).querySelector('p.mission-error'), null);
        } finally {
          tab.restoreFetch();
        }
      });
    }

    await check('a round sent from its board, or abandoned, takes the button off the card', async () => {
      await liveMission('SENT_ELSEWHERE');
      const sent = await actionRound('SENT_ELSEWHERE', 'merge', ['Merge', 'Hold']);
      await liveMission('ABANDONED');
      const abandoned = await actionRound('ABANDONED', 'fire', ['Fire', 'Not yet']);
      const tab = await openMissionsTab();
      const wire = openWireStream();
      try {
        await wire.connected();
        assert.deepEqual(actionButtons(cardFor(tab.document, 'SENT_ELSEWHERE')), [{ kind: 'merge', label: 'Merge' }]);
        assert.deepEqual(actionButtons(cardFor(tab.document, 'ABANDONED')), [{ kind: 'fire', label: 'Fire' }]);

        const r = await post(`/api/board/${sent.boardId}/submit`, { round: sent.round,
          answers: [{ id: sent.questionId, status: 'answered', choice: 'Hold', note: '' }] });
        assert.equal(r.status, 200);
        assert.equal((await post(`/api/board/${abandoned.boardId}/abandon`, {})).status, 200);
        await tab.push('waiting', (await wire.next('waiting')).data);
        assert.deepEqual(actionButtons(cardFor(tab.document, 'SENT_ELSEWHERE')), []);
        assert.deepEqual(actionButtons(cardFor(tab.document, 'ABANDONED')), []);
      } finally {
        wire.close();
        tab.restoreFetch();
      }
    });

    await check('Stop asks once, then posts a stop order, and the card says so until the order is acked', async () => {
      await liveMission('STOP_ME');
      const tab = await openMissionsTab();
      const wire = openWireStream();
      try {
        await wire.connected();
        await tab.click(cardFor(tab.document, 'STOP_ME').querySelector('button.mission-stop'));
        const asking = cardFor(tab.document, 'STOP_ME');
        assert.equal(asking.querySelector('p.mission-confirm-text').textContent,
          'Stop this session? It finishes its step, writes its Handoff and ends.');
        assert.deepEqual(asking.querySelectorAll('div.mission-confirm button').map(b => [b.textContent, b.getAttribute('aria-label')]),
          [['Stop', 'Stop this session'], ['Keep', 'Keep it working']]);
        assert.deepEqual((await mission('STOP_ME')).orders, [], 'the first click only asks');

        await tab.click(asking.querySelector('button.mission-stop-confirm'));
        const orders = (await mission('STOP_ME')).orders;
        assert.deepEqual(orders.map(o => [o.kind, o.by, o.relayedAt]), [['stop', 'card', undefined]]);
        let card = cardFor(tab.document, 'STOP_ME');
        assert.equal(card.querySelector('p.mission-order').textContent, 'Stop asked: waiting for the Master Chief to relay it');
        assert.equal(card.querySelector('button.mission-stop'), null, 'no second Stop while one is on its way');
        assert.equal(card.querySelector('div.mission-confirm'), null);

        assert.equal((await post(`/api/mission/STOP_ME/order/${orders[0].id}/ack`, {})).status, 200);
        await wire.next('missions'); // the order's own broadcast, from the click
        await tab.push('missions', (await wire.next('missions')).data);
        card = cardFor(tab.document, 'STOP_ME');
        assert.equal(card.querySelector('p.mission-order').textContent, 'Stop relayed: the session finishes its step, writes its Handoff and ends');
      } finally {
        wire.close();
        tab.restoreFetch();
      }
    });

    await check('a Cmd-click on Stop posts one stop order at once, with no question, and leaves no Stop to click while the order is out', async () => {
      await liveMission('STOP_AT_ONCE');
      const tab = await openMissionsTab();
      try {
        const stop = cardFor(tab.document, 'STOP_AT_ONCE').querySelector('button.mission-stop');
        assert.equal(stop.getAttribute('title'), 'Stop: finish the step, hand off, end. Cmd-click stops at once');
        stop.dispatchEvent(new StandInEvent('click', { metaKey: true, button: 0 }));
        const sending = cardFor(tab.document, 'STOP_AT_ONCE');
        assert.equal(sending.querySelector('p.mission-order').textContent, 'Stop asked: waiting for the Master Chief to relay it',
          'the card says so while the order is in flight');
        assert.equal(sending.querySelector('button.mission-stop'), null, 'no Stop left to click while it is in flight');
        await settler.settle();
        assert.deepEqual((await mission('STOP_AT_ONCE')).orders.map(o => [o.kind, o.by]), [['stop', 'card']]);
        const card = cardFor(tab.document, 'STOP_AT_ONCE');
        assert.equal(card.querySelector('div.mission-confirm'), null, 'no question');
        assert.equal(card.querySelector('p.mission-order').textContent, 'Stop asked: waiting for the Master Chief to relay it');
        assert.equal(card.querySelector('button.mission-stop'), null, 'no second Stop while one is on its way');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('a Stop click with Ctrl, Shift or Alt held only asks, as a plain one does', async () => {
      for (const held of ['ctrlKey', 'shiftKey', 'altKey']) {
        const key = `STOP_${held.toUpperCase()}`;
        await liveMission(key);
        const tab = await openMissionsTab();
        try {
          const stop = cardFor(tab.document, key).querySelector('button.mission-stop');
          stop.dispatchEvent(new StandInEvent('click', { [held]: true, button: 0 }));
          await settler.settle();
          assert.ok(cardFor(tab.document, key).querySelector('div.mission-confirm'), `${held}: the question shows`);
          assert.deepEqual((await mission(key)).orders, [], `${held}: nothing is posted`);
        } finally {
          tab.restoreFetch();
        }
      }
    });

    await check('Keep closes the Stop question and posts nothing', async () => {
      await liveMission('STOP_KEPT');
      const tab = await openMissionsTab();
      try {
        await tab.click(cardFor(tab.document, 'STOP_KEPT').querySelector('button.mission-stop'));
        await tab.click(cardFor(tab.document, 'STOP_KEPT').querySelector('button.mission-stop-cancel'));
        assert.equal(cardFor(tab.document, 'STOP_KEPT').querySelector('div.mission-confirm'), null);
        assert.deepEqual((await mission('STOP_KEPT')).orders, []);
      } finally {
        tab.restoreFetch();
      }
    });

    await check('with Comment on, a note on a card posts a comment order for that mission', async () => {
      await liveMission('COMMENT_ME');
      const tab = await openMissionsTab();
      try {
        const toggle = tab.document.querySelector('button#comment-mode-toggle');
        assert.equal(toggle.getAttribute('disabled'), null, 'Comment is on offer while a card is shown');
        await tab.click(cardFor(tab.document, 'COMMENT_ME').querySelector('b.mission-title'));
        assert.equal(cardFor(tab.document, 'COMMENT_ME').querySelector('textarea'), null, 'with Comment off a click opens nothing');

        await tab.click(toggle);
        assert.equal(toggle.getAttribute('aria-pressed'), 'true');
        assert.ok(tab.document.body.classList.contains('comment-mode'));
        await tab.click(cardFor(tab.document, 'COMMENT_ME').querySelector('b.mission-title'));
        const box = cardFor(tab.document, 'COMMENT_ME').querySelector('textarea.mission-comment-text');
        assert.equal(box.getAttribute('aria-label'), 'Comment for COMMENT_ME');
        box.value = 'Split the second PR before merging';
        box.dispatchEvent(new StandInEvent('input'));
        await tab.click(cardFor(tab.document, 'COMMENT_ME').querySelector('button.mission-comment-send'));

        assert.deepEqual((await mission('COMMENT_ME')).orders.map(o => [o.kind, o.text, o.by]),
          [['comment', 'Split the second PR before merging', 'card']]);
        const card = cardFor(tab.document, 'COMMENT_ME');
        assert.equal(card.querySelector('textarea'), null, 'the note closes once sent');
        assert.equal(card.querySelector('p.mission-order').textContent, 'Comment waiting for the Master Chief');
        assert.deepEqual((await mission('WORKING_ONE')).orders, [], 'no other mission got it');
      } finally {
        tab.restoreFetch();
      }
    });

    /** A tab with Comment on and `key`'s note open, holding `text`. */
    async function openNote(key, text) {
      const tab = await openMissionsTab();
      await tab.click(tab.document.querySelector('button#comment-mode-toggle'));
      await tab.click(cardFor(tab.document, key).querySelector('b.mission-title'));
      const box = cardFor(tab.document, key).querySelector('textarea.mission-comment-text');
      box.value = text;
      box.dispatchEvent(new StandInEvent('input'));
      return tab;
    }

    await check('a comment the daemon refuses shows its error on the open note, which keeps its text', async () => {
      await liveMission('COMMENT_REFUSED');
      const text = 'x'.repeat(4097);
      const tab = await openNote('COMMENT_REFUSED', text);
      try {
        await tab.click(cardFor(tab.document, 'COMMENT_REFUSED').querySelector('button.mission-comment-send'));
        assert.deepEqual((await mission('COMMENT_REFUSED')).orders, [], 'setup: a comment over 4096 bytes is refused');
        const card = cardFor(tab.document, 'COMMENT_REFUSED');
        assert.equal(card.querySelector('p.mission-error').textContent, 'Could not send the comment (400)');
        assert.equal(card.querySelector('textarea.mission-comment-text').value, text, 'the note stays open with what was written');
        assert.equal(card.querySelector('button.mission-comment-send').getAttribute('disabled'), null, 'and can be sent again');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('with a note open on the card, Stop asks there and Keep shuts the question, the note keeping its text', async () => {
      await liveMission('STOP_NOTED');
      const tab = await openNote('STOP_NOTED', 'Half a thought');
      try {
        await tab.click(cardFor(tab.document, 'STOP_NOTED').querySelector('button.mission-stop'));
        let card = cardFor(tab.document, 'STOP_NOTED');
        assert.equal(card.querySelector('p.mission-confirm-text').textContent,
          'Stop this session? It finishes its step, writes its Handoff and ends.');
        assert.equal(card.querySelector('button.mission-stop').getAttribute('aria-expanded'), 'true');
        assert.deepEqual((await mission('STOP_NOTED')).orders, [], 'the click only asks');

        await tab.click(card.querySelector('button.mission-stop-cancel'));
        card = cardFor(tab.document, 'STOP_NOTED');
        assert.equal(card.querySelector('div.mission-confirm'), null);
        assert.equal(card.querySelector('button.mission-stop').getAttribute('aria-expanded'), 'false');
        assert.equal(card.querySelector('textarea.mission-comment-text').value, 'Half a thought');
        assert.deepEqual((await mission('STOP_NOTED')).orders, []);
      } finally {
        tab.restoreFetch();
      }
    });

    await check('a second click on Send while the first is out sends nothing more, and Send is disabled meanwhile', async () => {
      await liveMission('COMMENT_TWICE');
      const tab = await openNote('COMMENT_TWICE', 'Once only');
      try {
        const send = cardFor(tab.document, 'COMMENT_TWICE').querySelector('button.mission-comment-send');
        send.dispatchEvent(new StandInEvent('click'));
        assert.equal(send.getAttribute('disabled'), '', 'Send is disabled while its request is out');
        // The stand-in delivers a click to a disabled button, which a browser would not.
        send.dispatchEvent(new StandInEvent('click'));
        await settler.settle();
        assert.deepEqual((await mission('COMMENT_TWICE')).orders.map(o => [o.kind, o.text]), [['comment', 'Once only']]);
        assert.equal(cardFor(tab.document, 'COMMENT_TWICE').querySelector('textarea'), null, 'the note closes once sent');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('a missions event on the daemon-wide stream re-reads the columns', async () => {
      const tab = await openMissionsTab();
      const wire = openWireStream();
      try {
        await wire.connected();
        assert.equal(cardFor(tab.document, 'ARRIVES_LATE'), null);
        assert.equal((await post('/api/mission/ARRIVES_LATE', { title: 'Arrives late', state: 'waiting', phase: 'grill' })).status, 200);
        await tab.push('missions', (await wire.next('missions')).data);
        assert.ok(columns(tab.document).waiting.includes('ARRIVES_LATE'));
        assert.equal(tab.document.querySelector('section.mission-col[data-col="waiting"] span.mission-col-count').textContent,
          String(columns(tab.document).waiting.length));
      } finally {
        wire.close();
        tab.restoreFetch();
      }
    });
    await check('Stop and comment on a tab card post orders to that session, and the card says each waits for the Master Chief until relayed (ADR 131)', async () => {
      const snapshot = sessions => post('/api/sessions', { intervalMs: 30000, sessions });
      const listed = { id: 'tab-orders', pid: 50101, procStart: '2026-10-29T08:00:00Z', kind: 'interactive', jobId: null, cwd: '/Users/pm/Documents/arkivia', login: '/Users/pm/.claude', name: 'catchup', status: 'idle', reason: null };
      const tabOrders = async () => {
        const r = await rawRequest(port, 'GET', '/api/missions', { headers: { [SECRET_HEADER]: SECRET } });
        return JSON.parse(r.body).tabs.find(t => t.id === listed.id).orders;
      };
      const key = `tab:${listed.id}`;
      assert.equal((await snapshot([listed])).status, 200);
      const tab = await openMissionsTab();
      const wire = openWireStream();
      try {
        await wire.connected();
        await tab.click(tab.document.querySelector('button#comment-mode-toggle'));
        await tab.click(cardFor(tab.document, key).querySelector('b.mission-title'));
        const box = cardFor(tab.document, key).querySelector('textarea.mission-comment-text');
        assert.equal(box.getAttribute('aria-label'), 'Comment for catchup');
        box.value = 'Park the rollout until Monday';
        box.dispatchEvent(new StandInEvent('input'));
        await tab.click(cardFor(tab.document, key).querySelector('button.mission-comment-send'));
        assert.deepEqual((await tabOrders()).map(o => [o.kind, o.text]), [['comment', 'Park the rollout until Monday']]);
        assert.equal(cardFor(tab.document, key).querySelector('p.mission-order').textContent, 'Comment waiting for the Master Chief');

        await tab.click(cardFor(tab.document, key).querySelector('button.mission-stop'));
        assert.equal(cardFor(tab.document, key).querySelector('p.mission-confirm-text').textContent,
          'Stop this session? It finishes its step, writes its Handoff and ends.');
        assert.equal((await tabOrders()).length, 1, 'the first Stop click only asks');
        await tab.click(cardFor(tab.document, key).querySelector('button.mission-stop-confirm'));
        const orders = await tabOrders();
        assert.deepEqual(orders.map(o => [o.kind, o.relayedAt]), [['comment', undefined], ['stop', undefined]]);
        let card = cardFor(tab.document, key);
        assert.deepEqual(card.querySelectorAll('p.mission-order').map(p => p.textContent),
          ['Stop asked: waiting for the Master Chief to relay it', 'Comment waiting for the Master Chief']);
        assert.equal(card.querySelector('button.mission-stop'), null, 'no second Stop while one is on its way');
        assert.deepEqual((await mission('WORKING_ONE')).orders, [], 'no mission got either order');

        assert.equal((await post(`/api/session/${listed.id}/order/${orders[1].id}/ack`, {})).status, 200);
        await tab.push('missions', (await wire.next('missions')).data);
        card = cardFor(tab.document, key);
        assert.equal(card.querySelector('p.mission-order').textContent, 'Stop relayed: the session finishes its step, writes its Handoff and ends');
      } finally {
        wire.close();
        tab.restoreFetch();
        await snapshot([]);
      }
    });
  } finally {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
}

runMain('missions-view', main, { cleanup: () => rmSync(workDir, { recursive: true, force: true }) });
