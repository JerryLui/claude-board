// The browser half of the shared stream (ADR 144): one SharedWorker per browser holds the
// one connection to the daemon (`GET /api/stream`), and every board tab and index tab
// talks to it over a MessagePort instead of opening an EventSource of its own. Chrome
// allows six connections per host over plain HTTP, and a reviewer through an SSH tunnel
// holding six tabs used to leave the seventh page waiting for a free slot.
//
// Two functions, each spliced by `.toString()` into what runs in the browser, so neither
// may reach anything in this module's scope: `openSharedStream` into the board page's and
// the index's scripts, and `streamWorker` into the worker's own source.
//
// Presence: a tab holds a Web Lock for its life and beats the worker; the worker drops a
// tab when the lock frees (the tab is gone), on its `pagehide`, or after a long silence,
// and beats the daemon for every tab it holds. The daemon drops a Watcher whose beats stop
// (src/browser-stream.mjs), so the stranded rule still sees a closed tab at once.
//
// The worker answers every hello and beat, and a tab whose worker has stopped answering
// opens a fresh one: Chrome tells a tab nothing when its worker ends or crashes, and a tab
// left on a dead port hears no push again, a round answered elsewhere included.

import { createHash } from 'node:crypto';

/** Opens this page's stream: through the browser's shared worker where there is one, else
 * an EventSource of its own on `opts.fallback`, as every page did before ADR 144. Answers
 * an object whose `addEventListener(name, fn)` hears the same events, `fn({ data })` with
 * `data` the event's JSON text: 'open' each time the stream (re)connects (for a board tab,
 * once its Watcher exists), then the board's or the daemon's own events.
 *
 * `opts`: `worker` (the worker's URL), `fallback` (the stream URL without a worker),
 * `board` (the board id, or null for the daemon-wide events), `held` (the page fills a
 * held stage frame, src/ui.mjs). */
export function openSharedStream(opts) {
  // Read off window, never as bare globals: a check's stand-in window then decides, not
  // whatever the node process running it exposes (QUIRKS.md, the new Function harness).
  var Shared = window.SharedWorker;
  if (!opts.worker || typeof Shared !== 'function') return new EventSource(opts.fallback);
  var listeners = {};
  var port = null;
  // Hellos and beats said on this port since the worker last answered one.
  var unanswered = 0;
  function connect() {
    var worker;
    try {
      worker = new Shared(opts.worker, { name: 'claude-board-stream' });
    } catch (e) {
      return false;
    }
    port = worker.port;
    unanswered = 0;
    port.onmessage = function (ev) {
      var m = ev.data;
      if (!m) return;
      if (m.type === 'ack') { unanswered = 0; return; }
      if (m.type !== 'event') return;
      (listeners[m.event] || []).forEach(function (fn) {
        try { fn({ data: m.data }); } catch (e) { /* one listener's throw never silences the rest */ }
      });
    };
    port.start();
    return true;
  }
  if (!connect()) return new EventSource(opts.fallback);
  var tab = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var lockName = 'claude-board-tab-' + tab;
  var locks = window.navigator && window.navigator.locks;
  var hasLocks = !!locks && typeof locks.request === 'function';
  function say(type) {
    if (type === 'hello' || type === 'beat') unanswered++;
    port.postMessage({ type: type, tab: tab, board: opts.board || null, held: !!opts.held, lock: hasLocks ? lockName : null });
  }
  function hello() { say('hello'); }
  // The same URL and name start a fresh worker once the old one is gone, and its hello
  // registers this tab there: the tab hears 'open' and re-reads what it missed. A worker
  // that was only slow is the same worker again, and takes the tab back.
  function reopen() {
    try { port.close(); } catch (e) { /* already gone */ }
    if (connect()) hello();
  }
  // The worker waits on this lock to learn the tab is gone, so the tab holds it before it
  // says hello: a worker asking first would be granted it and drop the tab at once.
  if (hasLocks) {
    locks.request(lockName, function () {
      hello();
      return new Promise(function () {});
    });
  } else {
    hello();
  }
  // A worker answers within a moment, so a hello or beat still unanswered at the next beat
  // means the worker is gone.
  setInterval(function () {
    if (unanswered > 0) reopen();
    else say('beat');
  }, 5000);
  // A tab shown again asks at once rather than at its next beat, which Chrome runs once a
  // minute in a tab hidden for five.
  var doc = window.document;
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState !== 'visible') return;
      say('beat');
      setTimeout(function () { if (unanswered > 0) reopen(); }, 2000);
    });
  }
  window.addEventListener('pagehide', function () { port.postMessage({ type: 'bye', tab: tab }); });
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) hello(); });
  return {
    addEventListener: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  };
}

/** The worker: one EventSource on `/api/stream` for every tab connected to it. Each frame
 * on that stream is `{ to, event, data }`: `to` null for a daemon-wide event, handed to
 * every tab with no board; else the Watcher id it is for, handed to that Watcher's tab.
 * The stream's first frame names it (`stream`), and every board tab is then registered
 * (`POST /api/stream/<id>/watch`); a reconnect is a new stream and registers them all
 * again, each tab hearing 'open' and its new 'watcher' as a reconnected EventSource did.
 *
 * `config.beatMs`: how often the worker beats the daemon; `config.tabSilenceMs`: how long a
 * tab may go without beating before it is dropped, past Chrome's once-a-minute timer
 * throttling of a tab hidden for five minutes. */
function streamWorker(config) {
  var tabs = {};
  var byWatcher = {};
  var streamId = null;
  var source = null;

  function send(t, event, data) {
    try { t.port.postMessage({ type: 'event', event: event, data: data === undefined ? '' : JSON.stringify(data) }); } catch (e) { /* the tab is gone; its lock or silence drops it */ }
  }

  function post(action, body) {
    return fetch('/api/stream/' + encodeURIComponent(streamId) + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error(action + ' answered ' + r.status);
      return r.json();
    });
  }

  function adopt(key, watcher) {
    var t = tabs[key];
    if (!t || t.watcher === watcher) return;
    if (t.watcher) delete byWatcher[t.watcher];
    t.watcher = watcher;
    byWatcher[watcher] = key;
    send(t, 'open');
    send(t, 'watcher', { id: watcher });
  }

  function watch(key) {
    var t = tabs[key];
    if (!t || !t.board || !streamId || t.watcher || t.pending === streamId) return;
    var sid = streamId;
    t.pending = sid;
    post('watch', { tab: key, board: t.board, held: t.held }).then(function (r) {
      if (tabs[key] === t && streamId === sid && r && typeof r.watcher === 'string') adopt(key, r.watcher);
    }, function () { /* the next beat asks again */ }).then(function () {
      if (t.pending === sid) t.pending = null;
    });
  }

  function drop(key) {
    var t = tabs[key];
    if (!t) return;
    delete tabs[key];
    if (t.watcher) {
      delete byWatcher[t.watcher];
      if (streamId) post('unwatch', { watcher: t.watcher }).catch(function () { /* the daemon's own sweep drops it */ });
    }
  }

  function onFrame(ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m.event !== 'string') return;
    var key;
    if (m.to == null && m.event === 'stream') {
      streamId = m.data && m.data.id;
      byWatcher = {};
      for (key in tabs) {
        tabs[key].watcher = null;
        tabs[key].pending = null;
        if (tabs[key].board) watch(key);
        else send(tabs[key], 'open');
      }
      return;
    }
    if (m.to == null) {
      for (key in tabs) if (!tabs[key].board) send(tabs[key], m.event, m.data);
      return;
    }
    if (m.event === 'watcher') {
      if (m.data && typeof m.data.tab === 'string') adopt(m.data.tab, m.to);
      return;
    }
    key = byWatcher[m.to];
    if (key && tabs[key]) send(tabs[key], m.event, m.data);
  }

  function connect() {
    source = new EventSource('/api/stream');
    source.onmessage = onFrame;
    source.onerror = function () {
      streamId = null;
      // A refused stream (a 401 once the secret rotates) is closed for good, unlike a
      // dropped one, which EventSource reopens on its own.
      if (source.readyState === 2) {
        source = null;
        setTimeout(connect, config.beatMs);
      }
    };
  }

  function register(port, m) {
    var t = { port: port, board: typeof m.board === 'string' ? m.board : null, held: !!m.held, watcher: null, pending: null, beatAt: Date.now() };
    if (tabs[m.tab]) drop(m.tab);
    tabs[m.tab] = t;
    if (m.lock && self.navigator && self.navigator.locks) {
      self.navigator.locks.request(m.lock, function () { if (tabs[m.tab] === t) drop(m.tab); });
    }
    if (!t.board && streamId) send(t, 'open');
    watch(m.tab);
  }

  self.onconnect = function (e) {
    var port = e.ports[0];
    port.onmessage = function (ev) {
      var m = ev.data;
      if (!m || typeof m.tab !== 'string') return;
      // Answered first, so a tab hears its worker is alive however the rest goes.
      if (m.type === 'hello' || m.type === 'beat') port.postMessage({ type: 'ack' });
      // A beat from a tab this worker no longer holds (dropped for silence while the
      // machine slept) registers it again, so a live tab never stays dropped.
      if (m.type === 'hello' || (m.type === 'beat' && !tabs[m.tab])) {
        register(port, m);
      } else if (m.type === 'beat') {
        if (tabs[m.tab].port === port) tabs[m.tab].beatAt = Date.now();
      } else if (m.type === 'bye') {
        if (tabs[m.tab] && tabs[m.tab].port === port) drop(m.tab);
      }
    };
    port.start();
  };

  setInterval(function () {
    var now = Date.now();
    var key;
    for (key in tabs) if (now - tabs[key].beatAt > config.tabSilenceMs) drop(key);
    if (!streamId) return;
    var watchers = [];
    for (key in tabs) {
      if (tabs[key].watcher) watchers.push(tabs[key].watcher);
      else watch(key);
    }
    if (!watchers.length) return;
    var sid = streamId;
    post('beat', { watchers: watchers }).then(function (r) {
      if (streamId !== sid || !r || !Array.isArray(r.unknown)) return;
      r.unknown.forEach(function (w) {
        var k = byWatcher[w];
        if (!k || !tabs[k]) return;
        delete byWatcher[w];
        tabs[k].watcher = null;
        watch(k);
      });
    }, function () { /* the next beat tries again */ });
  }, config.beatMs);

  connect();
}

export const STREAM_WORKER_BEAT_MS = 5000;

export const STREAM_WORKER_SOURCE = `(${streamWorker.toString()})(${JSON.stringify({ beatMs: STREAM_WORKER_BEAT_MS, tabSilenceMs: 75000 })});\n`;

/** Named by its own bytes, so a daemon update hands new tabs a new worker while tabs still
 * on the old page keep the old one. */
export const STREAM_WORKER_FILE = `worker-${createHash('sha256').update(STREAM_WORKER_SOURCE, 'utf8').digest('hex').slice(0, 16)}.js`;

export const STREAM_WORKER_URL = `/api/stream/${STREAM_WORKER_FILE}`;
