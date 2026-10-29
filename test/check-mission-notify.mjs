// The missions watch (src/mission-watch.mjs): its batched notification and its stream
// event for a derived change no write made. The batching rules run against a real
// missions store with an injected clock and a recording notifier (the notifier is the
// macOS port); the stream event runs against a real daemon whose session process is
// killed; the notifier's own two filters run against a stub osascript and the compiled
// launcher.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMissionWatch } from '../src/mission-watch.mjs';
import { upsertMission, launchMission, bindSession, STALL_SILENCE_MS } from '../src/missions.mjs';
import { notifyMissions } from '../src/notify.mjs';
import { writeDoc, defaultDoc } from '../src/pomodoro.mjs';
import { readMission } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import {
  buildLauncher, check, freshLog, haveCc, readJsonLines, runMain, secretHome, waitFor, waitForCount,
  withEnv, withStubOnPath, writeStub, STUB_OSASCRIPT,
} from './support.mjs';

process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-mission-notify-'));
const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const SECOND = 1000;

/** A fresh store, a clock the check moves, and a watch over both whose notifier records
 * each line it is handed. */
function rig({ bannerLevel } = {}) {
  const home = mkdtempSync(path.join(workDir, 'home-'));
  if (bannerLevel) writeDoc({ ...defaultDoc(), settings: { ...defaultDoc().settings, bannerLevel } }, home);
  const clock = { t: T0 };
  const posted = [];
  const broadcasts = [];
  const watch = createMissionWatch({
    home,
    now: () => clock.t,
    notify: line => posted.push(line),
    broadcast: key => broadcasts.push(key),
  });
  const at = (offsetMs, fn) => {
    clock.t = T0 + offsetMs;
    fn?.();
    watch.tick();
  };
  const set = (key, patch) => upsertMission(key, patch, { home, now: clock.t });
  return { home, clock, posted, broadcasts, watch, at, set };
}

async function main() {
  await check('three missions turning needs-you, released and needs-you within a minute post ONE notification, a minute after the first', () => {
    const r = rig();
    for (const key of ['ALPHA', 'BRAVO', 'CHARLIE']) r.set(key, { state: 'working' });
    r.at(0);
    r.at(10 * SECOND, () => r.set('ALPHA', { state: 'needs-you' }));
    r.at(20 * SECOND, () => r.set('BRAVO', { state: 'released' }));
    r.at(30 * SECOND, () => r.set('CHARLIE', { state: 'needs-you' }));
    r.at(60 * SECOND);
    assert.deepEqual(r.posted, [], 'nothing speaks before the window opened by the first transition closes');
    r.at(71 * SECOND);
    assert.deepEqual(r.posted, ['2 missions need you, BRAVO released']);
    r.watch.close();
  });

  await check('transitions more than a minute apart post two notifications, each naming its own mission', () => {
    const r = rig();
    for (const key of ['ALPHA', 'BRAVO']) r.set(key, { state: 'working' });
    r.at(0);
    r.at(10 * SECOND, () => r.set('ALPHA', { state: 'needs-you' }));
    r.at(75 * SECOND, () => r.set('BRAVO', { state: 'released' }));
    assert.deepEqual(r.posted, ['ALPHA needs you'], 'the first window closed before the second transition joined it');
    r.at(140 * SECOND);
    assert.deepEqual(r.posted, ['ALPHA needs you', 'BRAVO released']);
    r.watch.close();
  });

  await check('the first read after a start is a baseline: missions already needing the PM, stalled or released post nothing', async () => {
    const r = rig();
    r.set('ALPHA', { state: 'needs-you' });
    r.set('BRAVO', { state: 'released' });
    launchMission('CHARLIE', { phase: 'direct' }, { home: r.home, now: T0 - STALL_SILENCE_MS - 60 * SECOND });
    for (let i = 0; i < 2; i++) {
      // A restart is a new watch over the same store.
      const restarted = createMissionWatch({
        home: r.home,
        now: () => r.clock.t,
        notify: line => r.posted.push(line),
        broadcast: key => r.broadcasts.push(key),
      });
      r.clock.t = T0 + i * 10 * 60 * SECOND;
      restarted.tick();
      r.clock.t += 2 * 60 * SECOND;
      restarted.tick();
      restarted.close();
    }
    assert.deepEqual(r.posted, []);
    assert.deepEqual(r.broadcasts, []);
  });

  await check('a working session silent past 15 minutes is noticed by the watch: a missions event with no write behind it, then "<key> stalled"', () => {
    const r = rig();
    launchMission('DELTA', { phase: 'direct' }, { home: r.home, now: T0 });
    const written = readMission('DELTA', r.home).updatedAt;
    r.at(60 * SECOND);
    assert.deepEqual(r.broadcasts, []);
    r.at(STALL_SILENCE_MS + 2 * SECOND);
    assert.deepEqual(r.broadcasts, ['DELTA'], 'the stall changed the derived state only, so the watch publishes it');
    assert.equal(readMission('DELTA', r.home).updatedAt, written, 'the watch wrote nothing');
    r.at(STALL_SILENCE_MS + 63 * SECOND);
    assert.deepEqual(r.posted, ['DELTA stalled']);
    r.watch.close();
  });

  await check('a stored change is not re-published by the watch: its route already published it', () => {
    const r = rig();
    r.set('ECHO', { state: 'working' });
    r.at(0);
    r.at(10 * SECOND, () => r.set('ECHO', { state: 'released' }));
    assert.deepEqual(r.broadcasts, []);
    r.watch.close();
  });

  await check('a mission that moves on before its batch speaks leaves the batch, and an empty batch posts nothing', () => {
    const r = rig();
    r.set('FOXTROT', { state: 'working' });
    r.at(0);
    r.at(10 * SECOND, () => r.set('FOXTROT', { state: 'needs-you' }));
    r.at(40 * SECOND, () => r.set('FOXTROT', { state: 'working' }));
    r.at(80 * SECOND);
    assert.deepEqual(r.posted, []);
    r.watch.close();
  });

  await check('the batch speaks when its window timer fires, though the clock reads a hair before the window closes or the read fails', async () => {
    for (const readFails of [false, true]) {
      const clock = { t: T0 };
      const posted = [];
      let spoke;
      const spoken = new Promise(resolve => { spoke = resolve; });
      let views = [{ key: 'GOLF', view: 'working', updatedAt: 'u1' }];
      let failing = false;
      const watch = createMissionWatch({
        now: () => clock.t,
        read: () => { if (failing) throw new Error('missions unreadable'); return views; },
        notify: line => { posted.push(line); spoke(); },
        level: () => 'always',
        intervalMs: 24 * 60 * 60 * 1000,
        windowMs: 40,
      });
      watch.tick();
      views = [{ key: 'GOLF', view: 'needs-you', updatedAt: 'u2' }];
      watch.tick();
      // The timer's own read: the clock still 1 ms short of the window's end.
      clock.t = T0 + 39;
      failing = readFails;
      // A held timer, not withTimeout's unref'd one: the window timer is unref'd too, and
      // with nothing holding the loop the process would exit before it fires.
      let bound;
      await Promise.race([spoken, new Promise((_, reject) => { bound = setTimeout(() => reject(new Error('the window timer never spoke the batch')), 30_000); })]);
      clearTimeout(bound);
      watch.close();
      assert.deepEqual(posted, ['GOLF needs you'], readFails ? 'a failed read' : 'an early clock');
    }
  });

  await check('ADR 106: Banner level Off silences the missions notification too', () => {
    const r = rig({ bannerLevel: 'off' });
    r.set('GOLF', { state: 'working' });
    r.at(0);
    r.at(10 * SECOND, () => r.set('GOLF', { state: 'needs-you' }));
    r.at(80 * SECOND);
    assert.deepEqual(r.posted, []);
    r.watch.close();
  });

  await check('the line names work by title or key and counts it, and carries no other field of a mission', () => {
    const r = rig();
    const caseContent = {
      summary: 'SECRET_SUMMARY Svensson settlement',
      waitingOn: 'SECRET_WAITING',
      next: 'SECRET_NEXT',
      handoff: 'SECRET_HANDOFF',
      cwd: '/Users/someone/SECRET_CWD',
      prs: [{ repo: 'SECRET_REPO', number: 7, url: 'https://github.com/x/SECRET_URL/pull/7', state: 'open' }],
    };
    r.set('HOTEL', { state: 'working', title: 'Front agent', ...caseContent });
    r.set('INDIA', { state: 'working', title: 'Svensson v. Bank: merger, 2026', ...caseContent });
    r.set('JULIET', { state: 'working', title: 'J'.repeat(41), ...caseContent });
    r.at(0);
    r.at(5 * SECOND, () => r.set('HOTEL', { state: 'needs-you' }));
    r.at(6 * SECOND, () => r.set('INDIA', { state: 'released' }));
    r.at(7 * SECOND, () => r.set('JULIET', { state: 'released' }));
    r.at(70 * SECOND);
    assert.deepEqual(r.posted, ['Front agent needs you, 2 missions released'],
      'a title that is a plain name is shown; a group of two is counted');
    r.set('INDIA', { state: 'working' });
    r.at(100 * SECOND);
    r.at(110 * SECOND, () => r.set('INDIA', { state: 'released' }));
    r.at(180 * SECOND);
    assert.deepEqual(r.posted.slice(1), ['INDIA released'], 'a title outside the name pattern falls back to the key');
    r.watch.close();
  });

  await check('a line too long to name every mission counts them instead', () => {
    const r = rig();
    const keys = ['K'.repeat(40), 'L'.repeat(40), 'M'.repeat(40)];
    for (const key of keys) r.set(key, { state: 'working' });
    r.at(0);
    r.at(5 * SECOND, () => {
      r.set(keys[0], { state: 'needs-you' });
      r.set(keys[1], { state: 'released' });
    });
    r.at(6 * SECOND, () => launchMission(keys[2], { phase: 'direct' }, { home: r.home, now: T0 - STALL_SILENCE_MS }));
    r.at(70 * SECOND);
    assert.deepEqual(r.posted, ['1 mission needs you, 1 mission stalled, 1 mission released']);
    r.watch.close();
  });

  await check('the notifier: titled Missions, the line crosses whole, and a line outside its filter shows the unnamed sentence', async () => {
    const stubDir = path.join(workDir, 'stub-bin');
    writeStub(stubDir, 'osascript', STUB_OSASCRIPT);
    for (const [line, body] of [
      ['2 missions need you, BRAVO released', '2 missions need you, BRAVO released'],
      ['ALPHA needs you"; do shell script "rm -rf ~"', 'A mission changed.'],
      ['a'.repeat(120), 'A mission changed.'],
    ]) {
      const log = freshLog(workDir);
      await withStubOnPath(stubDir, log, {}, async () => {
        notifyMissions(line);
        const lines = await waitForCount(() => readJsonLines(log), 1);
        assert.deepEqual(lines, [['-e', `display notification "${body}" with title "Missions"`]]);
      });
    }
  });

  if (haveCc()) {
    await check('the compiled launcher: the missions row admits a comma line under its own filter, and the round row still refuses a comma', () => {
      const dir = mkdtempSync(path.join(workDir, 'launcher-'));
      const stub = path.join(dir, 'stub-notify.c');
      writeFileSync(stub, `#include <stdio.h>
int cb_notify(const char *title, const char *body, const char *cue_name, int use_default_sound,
              const char *board_url, int click_seconds) {
  printf("title=%s\\nbody=%s\\nurl=%s\\n", title ? title : "(null)", body ? body : "(null)", board_url ? board_url : "(null)");
  (void)cue_name; (void)use_default_sound; (void)click_seconds;
  return 0;
}
int cb_menubar(void) { return 0; }
int cb_menubar_probe(void) { return 0; }
`);
      const launcher = buildLauncher(dir, { node: '/nonexistent/node', daemon: '/nonexistent/daemon.mjs', link: [stub] });
      assert.equal(launcher.build.status, 0, launcher.build.stderr);
      const run = args => spawnSync(launcher.exec, ['--notify', ...args], { encoding: 'utf8', timeout: 10_000 }).stdout;
      assert.equal(run(['missions', '2 missions need you, BRAVO released']),
        'title=Missions\nbody=2 missions need you, BRAVO released\nurl=(null)\n');
      assert.equal(run(['missions', 'ALPHA needs you; open evil']), 'title=Missions\nbody=A mission changed.\nurl=(null)\n');
      assert.equal(run(['missions', 'a'.repeat(120)]), 'title=Missions\nbody=A mission changed.\nurl=(null)\n');
      assert.equal(run(['round', 'my,project']), 'title=Board\nbody=A round is waiting.\nurl=(null)\n');
    });
  }

  await check('the daemon: a session whose process dies emits missions on the daemon-wide stream with no write, within the watch interval', async () => {
    await withEnv({ CLAUDE_BOARD_MISSION_WATCH_MS: '100' }, async () => {
      const { home, secret } = secretHome('claude-board-mission-watch-daemon-', { setHome: false });
      writeDoc({ ...defaultDoc(), settings: { ...defaultDoc().settings, bannerLevel: 'off' } }, home);
      const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      // On disk with its session alive before the daemon starts, so the watch's baseline
      // read, which startServer makes before it answers, has read KILO as working.
      launchMission('KILO', { phase: 'direct' }, { home });
      bindSession('KILO', { pid: session.pid }, { home });
      const written = readMission('KILO', home).updatedAt;
      const { server, port } = await startServer({ home, port: 0, secret });
      const events = [];
      let req;
      try {
        let raw = '';
        let pending = '';
        req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: secret } }, res => {
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
          });
        });
        req.on('error', () => {});
        req.end();
        await waitFor(() => raw.includes(': connected'), { what: 'the stream opened' });
        await new Promise(resolve => { session.once('exit', resolve); session.kill('SIGKILL'); });
        await waitFor(() => events.some(e => e.name === 'missions' && e.data.key === 'KILO'),
          { what: 'a missions event for the stalled session' });
        // The stream delivers in order, so a publish while the session lived would sit ahead of it.
        assert.deepEqual(events.filter(e => e.name === 'missions').map(e => e.data.key), ['KILO'], 'nothing was published while the session lived');
        assert.equal(readMission('KILO', home).updatedAt, written, 'nothing wrote the mission');
      } finally {
        req?.destroy();
        session.kill('SIGKILL');
        await new Promise(resolve => server.close(resolve));
      }
    });
  });
}

await runMain('mission-notify', main);
