// The daemon half of the shared stream (ADR 144): `GET /api/stream` and its `watch`,
// `unwatch` and `beat` writes, against a real daemon on an ephemeral port. A Watcher
// registered on a shared stream is counted, pushed to and dropped exactly as a tab holding
// its own `/events` stream is: dropped when its worker says so, when the stream closes, and
// when no beat names it for the TTL. The browser half (the worker, the tab's lock, Chrome's
// connection cap) is test/browser-check-shared-stream.mjs's.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { startServer } from '../src/server.mjs';
import { STREAM_WORKER_URL } from '../src/stream-worker.mjs';
import { check, postBoard, rawRequest, runMain, secretHome, sessionCookieHeader, sleep, waitFor } from './support.mjs';

const TTL_MS = 400;
process.env.CLAUDE_BOARD_STREAM_BEAT_TTL_MS = String(TTL_MS);

/** Opens `GET /api/stream` with `headers` and collects its `data:` frames, parsed. */
function openStream(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/stream', headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const frames = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split('\n').find(l => l.startsWith('data:'));
          if (line) frames.push(JSON.parse(line.slice('data:'.length).trim()));
        }
      });
      resolve({ req, res, frames, status: res.statusCode });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const { home, secret } = secretHome('cb-shared-stream-');
  const cookie = { cookie: sessionCookieHeader(secret) };
  const { server, port } = await startServer({ home, port: 0 });
  const write = (streamId, action, body, headers = cookie) => rawRequest(port, 'POST', `/api/stream/${streamId}/${action}`, {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const awaited = title => ({ title, blocks: [{ kind: 'question', prompt: `${title}?`, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  const clientsOf = async boardId => (await postBoard(port, secret, { boardId, blocks: [{ kind: 'markdown', text: 'count' }] })).clients;
  const opened = async () => {
    const s = await openStream(port, cookie);
    const first = await waitFor(() => s.frames.find(f => f.event === 'stream'), { what: 'the stream naming itself' });
    return { ...s, id: first.data.id };
  };

  try {
    const a = await postBoard(port, secret, awaited('Board A'));
    const b = await postBoard(port, secret, awaited('Board B'));

    await check('the stream, its worker and its writes are refused without a credential', async () => {
      const stream = await openStream(port, {});
      stream.req.destroy();
      assert.equal(stream.status, 401);
      assert.equal((await rawRequest(port, 'GET', STREAM_WORKER_URL)).status, 401);
      assert.equal((await write('whatever', 'watch', { tab: 't1', board: a.boardId }, {})).status, 401);
    });

    await check('the worker script is served under a policy allowing only same-origin connections', async () => {
      const r = await rawRequest(port, 'GET', STREAM_WORKER_URL, { headers: cookie });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; connect-src 'self'");
    });

    await check('a watched tab is its board\'s Watcher: its watcher frame comes first, then its board\'s pushes, beside the daemon-wide events', async () => {
      const s = await opened();
      try {
        const r = await write(s.id, 'watch', { tab: 'tab-a', board: a.boardId, held: true });
        assert.equal(r.status, 200, r.body);
        const { watcher } = JSON.parse(r.body);
        assert.equal(await clientsOf(a.boardId), 1);
        assert.equal(await clientsOf(b.boardId), 0, 'another board gained no Watcher');
        await waitFor(() => s.frames.some(f => f.to === watcher && f.event === 'round'), { what: 'the push to board A' });
        const mine = s.frames.filter(f => f.to === watcher);
        assert.deepEqual(mine[0], { to: watcher, event: 'watcher', data: { id: watcher, tab: 'tab-a' } });
        assert.ok(mine.slice(1).every(f => f.event === 'round'), `unexpected frames: ${JSON.stringify(mine.slice(1))}`);
        await waitFor(() => s.frames.some(f => f.to === null && f.event === 'waiting'), { what: 'the daemon-wide waiting count' });
      } finally {
        s.req.destroy();
      }
    });

    await check('unwatch drops the Watcher at once and leaves the stream\'s others', async () => {
      const s = await opened();
      try {
        const wa = JSON.parse((await write(s.id, 'watch', { tab: 'tab-a', board: a.boardId })).body).watcher;
        await write(s.id, 'watch', { tab: 'tab-b', board: b.boardId });
        assert.deepEqual(JSON.parse((await write(s.id, 'unwatch', { watcher: wa })).body), { ok: true });
        assert.equal(await clientsOf(a.boardId), 0);
        assert.equal(await clientsOf(b.boardId), 1);
      } finally {
        s.req.destroy();
      }
    });

    await check('the stream closing drops every Watcher it carried', async () => {
      const s = await opened();
      await write(s.id, 'watch', { tab: 'tab-a', board: a.boardId });
      await write(s.id, 'watch', { tab: 'tab-b', board: b.boardId });
      s.req.destroy();
      await waitFor(async () => (await clientsOf(a.boardId)) === 0 && (await clientsOf(b.boardId)) === 0, { timeoutMs: 2000, intervalMs: 50, what: 'both Watchers dropping' });
    });

    await check('a beaten Watcher outlives the TTL; one no beat names is dropped, and the next beat reports it unknown', async () => {
      const s = await opened();
      try {
        const wa = JSON.parse((await write(s.id, 'watch', { tab: 'tab-a', board: a.boardId })).body).watcher;
        const wb = JSON.parse((await write(s.id, 'watch', { tab: 'tab-b', board: b.boardId })).body).watcher;
        for (let i = 0; i < 6; i++) {
          await sleep(TTL_MS / 4);
          assert.deepEqual(JSON.parse((await write(s.id, 'beat', { watchers: [wa] })).body), { unknown: [] });
        }
        assert.equal(await clientsOf(a.boardId), 1, 'the beaten Watcher was dropped');
        assert.equal(await clientsOf(b.boardId), 0, 'the silent Watcher outlived the TTL');
        assert.deepEqual(JSON.parse((await write(s.id, 'beat', { watchers: [wa, wb] })).body), { unknown: [wb] });
      } finally {
        s.req.destroy();
      }
    });

    await check('a write naming a stream or board this daemon does not hold is a 404', async () => {
      const s = await opened();
      try {
        assert.equal((await write('0'.repeat(32), 'watch', { tab: 'tab-a', board: a.boardId })).status, 404);
        assert.equal((await write('0'.repeat(32), 'beat', { watchers: [] })).status, 404);
        assert.equal((await write(s.id, 'watch', { tab: 'tab-a', board: 'b_missing' })).status, 404);
      } finally {
        s.req.destroy();
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

runMain('check-shared-stream', main);
