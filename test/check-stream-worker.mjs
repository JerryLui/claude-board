// The browser half of the shared stream (ADR 144) between a tab and its worker: a tab keeps
// a worker that answers it, and opens a fresh one once its worker has ended, which Chrome
// does not tell the tab (a crash, or End process in Chrome's Task Manager). Left on the dead
// port, every tab of that browser heard no push again: a round sent from one of them stayed
// open, dotted and counting down in all of them, the sending tab included.
//
// Driven for real: `openSharedStream` as the pages splice it, and `STREAM_WORKER_SOURCE` as
// the daemon serves it, on a stand-in SharedWorker that starts the worker source once per
// URL and name and can end it, its ports delivering nothing once it has. The daemon half
// is test/check-shared-stream.mjs's; Chrome ending a real worker, and failing to load one
// whose script is gone, is test/browser-check-answered-tabs.mjs's.

import assert from 'node:assert/strict';
import { openSharedStream, STREAM_WORKER_SOURCE, STREAM_WORKER_URL } from '../src/stream-worker.mjs';
import { check, finish } from './support.mjs';

const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};

/** A port pair between a tab and `worker`: a message is delivered a microtask later, and
 * never once the worker has ended or either end has closed. */
function portPair(worker) {
  const end = () => ({
    onmessage: null,
    closed: false,
    peer: null,
    start() {},
    close() { this.closed = true; },
    postMessage(data) {
      const to = this.peer;
      if (this.closed || to.closed || worker.ended) return;
      const copy = structuredClone(data);
      queueMicrotask(() => { if (!worker.ended && !to.closed && to.onmessage) to.onmessage({ data: copy }); });
    },
  });
  const tabEnd = end();
  const workerEnd = end();
  tabEnd.peer = workerEnd;
  workerEnd.peer = tabEnd;
  return { tabEnd, workerEnd };
}

/** One browser's SharedWorkers: `new SharedWorker(url, { name })` connects to the running
 * worker of that URL and name, else starts the worker source afresh, or, once the check
 * sets `gone` (a daemon update took the script's URL away), fires 'error' at the
 * SharedWorker a moment later and starts nothing, as Chrome does on a 404. Each worker's
 * EventSource is a stand-in the check opens (`openStream`), its fetch answers every
 * `watch` with a new Watcher id, and `posts` lists the routes it posted to. `connects`
 * counts the tab's `new SharedWorker` calls. */
function browser() {
  const running = new Map();
  const started = [];
  const b = { SharedWorker, started, gone: false, connects: 0 };
  function start() {
    const worker = { ended: false, sources: [], hellos: [], posts: [], self: { navigator: {} } };
    class Source {
      constructor(url) { this.url = url; this.readyState = 1; worker.sources.push(this); }
      close() {}
    }
    let watchers = 0;
    const fetch = url => {
      worker.posts.push(url.split('/').at(-1));
      const answer = url.endsWith('/watch') ? { watcher: `w${started.length}-${++watchers}` } : { unknown: [] };
      return Promise.resolve({ ok: true, json: async () => answer });
    };
    new Function('self', 'EventSource', 'fetch', 'setInterval', 'setTimeout', STREAM_WORKER_SOURCE)(
      worker.self, Source, fetch, () => 0, () => 0,
    );
    worker.openStream = id => worker.sources.at(-1).onmessage({ data: JSON.stringify({ to: null, event: 'stream', data: { id } }) });
    started.push(worker);
    return worker;
  }
  function SharedWorker(url, opts) {
    b.connects++;
    const key = `${url}|${opts && opts.name}`;
    let worker = running.get(key);
    if ((!worker || worker.ended) && b.gone) {
      const errorListeners = [];
      this.addEventListener = (name, fn) => { if (name === 'error') errorListeners.push(fn); };
      this.onerror = null;
      this.port = portPair({ ended: true }).tabEnd;
      setImmediate(() => {
        const ev = { type: 'error' };
        if (this.onerror) this.onerror(ev);
        errorListeners.forEach(fn => fn(ev));
      });
      return;
    }
    if (!worker || worker.ended) {
      worker = start();
      running.set(key, worker);
    }
    const { tabEnd, workerEnd } = portPair(worker);
    worker.self.onconnect({ ports: [workerEnd] });
    // Records each hello this worker hears, ahead of the worker's own handling of it.
    const handle = workerEnd.onmessage;
    workerEnd.onmessage = ev => {
      if (ev.data && ev.data.type === 'hello') worker.hellos.push(ev.data.tab);
      handle(ev);
    };
    this.port = tabEnd;
    this.addEventListener = () => {};
  }
  return b;
}

class NoEventSource {
  constructor(url) { throw new Error(`the tab fell back to its own EventSource on ${url}`); }
}

/** The stream a tab opens of its own, as `EventSource`: `opened` lists each one's URL, and
 * `emit(name)` hands the last one's listeners an event. */
function ownStreams() {
  const opened = [];
  class OwnSource {
    constructor(url) { this.listeners = {}; opened.push(url); OwnSource.last = this; }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  }
  return { EventSource: OwnSource, opened, emit: name => (OwnSource.last.listeners[name] || []).forEach(fn => fn({ data: '{}' })) };
}

/** A board tab of `board` in `b`, through the page's own `openSharedStream`: its beats
 * (`beat()`) and its timers (`runTimers()`) run when the check says, and `show()` and
 * `hide()` change what `document.visibilityState` says. `heard` lists every 'open' and
 * 'watcher' it is handed. `EventSource` is what a stream of its own would be. */
function tab(b, board, EventSource = NoEventSource) {
  const beats = [];
  const timers = [];
  const docListeners = {};
  const doc = {
    visibilityState: 'visible',
    addEventListener(name, fn) { (docListeners[name] = docListeners[name] || []).push(fn); },
  };
  const win = { SharedWorker: b.SharedWorker, navigator: {}, document: doc, addEventListener() {} };
  const open = new Function('window', 'EventSource', 'setInterval', 'setTimeout', `return (${openSharedStream.toString()});`)(
    win, EventSource, fn => { beats.push(fn); return beats.length; }, fn => { timers.push(fn); return timers.length; },
  );
  const stream = open({ worker: STREAM_WORKER_URL, fallback: `/api/board/${board}/events?stages=held`, board, held: true });
  const heard = [];
  for (const name of ['open', 'watcher']) stream.addEventListener(name, () => heard.push(name));
  const visibility = state => {
    doc.visibilityState = state;
    for (const fn of docListeners.visibilitychange || []) fn();
  };
  return {
    heard,
    beat: () => beats.forEach(fn => fn()),
    runTimers: () => timers.splice(0).forEach(fn => fn()),
    hide: () => visibility('hidden'),
    show: () => visibility('visible'),
  };
}

/** A tab of a fresh browser, registered on its worker's stream and told so. */
async function registeredTab(EventSource) {
  const b = browser();
  const t = tab(b, 'b_board', EventSource);
  await settle();
  b.started[0].openStream('stream-1');
  await settle();
  assert.deepEqual(t.heard, ['open', 'watcher'], 'setup: the tab was never registered on its worker');
  return { b, t };
}

await check('a tab beating a live worker, and shown again beside it, keeps it: no second worker, no second open', async () => {
  const { b, t } = await registeredTab();
  for (let i = 0; i < 3; i++) {
    t.beat();
    await settle();
  }
  t.hide();
  t.show();
  await settle();
  t.runTimers();
  t.beat();
  await settle();
  assert.equal(b.started.length, 1, `a live worker was replaced: ${b.started.length} workers started`);
  assert.deepEqual(t.heard, ['open', 'watcher']);
});

await check('a tab hidden long enough for Chrome to beat it once a minute, shown again, its overdue beat running before the worker answers the beat it said on showing, keeps its worker: no unwatch, no second open', async () => {
  const { b, t } = await registeredTab();
  t.hide();
  for (let i = 0; i < 3; i++) {
    t.beat();
    await settle();
  }
  t.show();
  t.beat();
  await settle();
  t.runTimers();
  t.beat();
  await settle();
  assert.equal(b.started.length, 1, `a live worker was replaced: ${b.started.length} workers started`);
  assert.deepEqual(b.started[0].posts.filter(route => route !== 'beat'), ['watch'], 'the worker dropped the tab and registered it again, so the daemon saw it leave and come back');
  assert.deepEqual(t.heard, ['open', 'watcher']);
});

await check('a tab whose worker ended opens a fresh one at its second beat, says hello there, and hears open again to re-read the board', async () => {
  const { b, t } = await registeredTab();
  b.started[0].ended = true;
  t.beat();
  await settle();
  t.beat();
  await settle();
  assert.equal(b.started.length, 2, 'the tab stayed on its ended worker');
  assert.equal(b.started[1].hellos.length, 1, 'the tab never said hello to the fresh worker');
  b.started[1].openStream('stream-2');
  await settle();
  assert.deepEqual(t.heard, ['open', 'watcher', 'open', 'watcher']);
});

await check('a tab shown again finds its ended worker without waiting for its next beat', async () => {
  const { b, t } = await registeredTab();
  t.hide();
  b.started[0].ended = true;
  t.show();
  await settle();
  t.runTimers();
  await settle();
  assert.equal(b.started.length, 2, 'the tab shown again stayed on its ended worker');
  b.started[1].openStream('stream-2');
  await settle();
  assert.deepEqual(t.heard, ['open', 'watcher', 'open', 'watcher']);
});

await check('a tab whose worker ended after a daemon update took its script away opens a stream of its own, hears open there to re-read the board, and stops asking for the script', async () => {
  const own = ownStreams();
  const { b, t } = await registeredTab(own.EventSource);
  b.gone = true;
  b.started[0].ended = true;
  t.beat();
  await settle();
  t.beat();
  await settle();
  assert.deepEqual(own.opened, ['/api/board/b_board/events?stages=held'], 'the tab never opened a stream of its own');
  own.emit('open');
  own.emit('watcher');
  assert.deepEqual(t.heard, ['open', 'watcher', 'open', 'watcher']);
  const connects = b.connects;
  for (let i = 0; i < 3; i++) {
    t.beat();
    await settle();
  }
  t.hide();
  t.show();
  t.runTimers();
  await settle();
  assert.equal(b.connects, connects, 'the tab on its own stream still asks for the worker script that is gone');
  assert.equal(own.opened.length, 1);
});

finish('check-stream-worker');
