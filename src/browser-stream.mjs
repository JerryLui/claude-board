// The daemon half of the shared stream (ADR 144; the browser half is src/stream-worker.mjs):
// one `GET /api/stream` connection per browser carries the daemon-wide events and the
// events of every board a tab of that browser has open. A board tab is registered as a
// Watcher on its board's hub (`createSseHub`) with this connection as its socket, so the
// stranded rule, the auto-open check and `clients` read it as they read a tab holding its
// own stream. What the connection closing cannot show, one tab of many going away, the
// worker says (`unwatch`), and a Watcher it stops beating for is dropped by the sweep.

import { randomBytes } from 'node:crypto';

/** How long a Watcher on a shared stream counts without a beat naming it. The worker beats
 * every five seconds (src/stream-worker.mjs), so four beats are missed before it goes. */
export const DEFAULT_STREAM_BEAT_TTL_MS = 20_000;

function beatTtlMs() {
  const v = Number(process.env.CLAUDE_BOARD_STREAM_BEAT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STREAM_BEAT_TTL_MS;
}

function frame(to, eventName, json) {
  return `data: {"to":${JSON.stringify(to)},"event":${JSON.stringify(eventName)},"data":${json}}\n\n`;
}

/** `sse`: the board hub (`createSseHub`); `stream`: the daemon-wide hub (`createStreamHub`);
 * `onWatchersChanged(boardId, target)`: called each time a board gains or loses a Watcher
 * here, with the stranded target captured when that Watcher registered. */
export function createBrowserStreams({ sse, stream, onWatchersChanged }) {
  const streams = new Map(); // streamId -> { res, daemonSub, watchers: Map<watcherId, { boardId, target, beatAt }> }

  function dropWatcher(s, watcherId) {
    const w = s.watchers.get(watcherId);
    if (!w) return false;
    s.watchers.delete(watcherId);
    sse.unsubscribe(w.boardId, watcherId);
    onWatchersChanged(w.boardId, w.target);
    return true;
  }

  return {
    /** Registers the connection `res` and writes its first frame, naming it. */
    open(res) {
      const id = randomBytes(16).toString('hex');
      const s = { res, watchers: new Map(), daemonSub: null };
      s.daemonSub = stream.subscribe(res, (eventName, json) => res.write(frame(null, eventName, json)));
      streams.set(id, s);
      res.write(frame(null, 'stream', JSON.stringify({ id })));
      return id;
    },
    close(id) {
      const s = streams.get(id);
      if (!s) return;
      streams.delete(id);
      stream.unsubscribe(s.daemonSub);
      for (const watcherId of [...s.watchers.keys()]) dropWatcher(s, watcherId);
    },
    /** A tab of this browser opened `boardId`: answers its Watcher id, or null for a stream
     * this daemon does not hold. The `watcher` frame naming the tab goes down the stream
     * ahead of any push to it. */
    watch(id, { boardId, tab, fillsHeld, target }) {
      const s = streams.get(id);
      if (!s) return null;
      let watcherId = null;
      watcherId = sse.subscribe(boardId, s.res, {
        fillsHeld,
        relay: (eventName, json) => s.res.write(frame(watcherId, eventName, json)),
      });
      s.watchers.set(watcherId, { boardId, target, beatAt: Date.now() });
      s.res.write(frame(watcherId, 'watcher', JSON.stringify({ id: watcherId, tab })));
      onWatchersChanged(boardId, target);
      return watcherId;
    },
    /** Answers whether the stream held that Watcher. */
    unwatch(id, watcherId) {
      const s = streams.get(id);
      return !!s && dropWatcher(s, watcherId);
    },
    /** Answers the named Watchers this stream does not hold, for the worker to register
     * again, or null for a stream this daemon does not hold. */
    beat(id, watcherIds) {
      const s = streams.get(id);
      if (!s) return null;
      const now = Date.now();
      const unknown = [];
      for (const watcherId of watcherIds) {
        const w = s.watchers.get(watcherId);
        if (w) w.beatAt = now;
        else unknown.push(watcherId);
      }
      return unknown;
    },
    /** Drops every Watcher no beat has named for the TTL. */
    sweep() {
      const cutoff = Date.now() - beatTtlMs();
      for (const s of streams.values()) {
        for (const [watcherId, w] of [...s.watchers]) {
          if (w.beatAt < cutoff) dropWatcher(s, watcherId);
        }
      }
    },
    sweepEveryMs() {
      return Math.max(10, Math.min(5000, Math.floor(beatTtlMs() / 4)));
    },
  };
}
