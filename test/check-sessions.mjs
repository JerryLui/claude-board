// The session list (src/sessions.mjs) through its own exports, with an injected clock where
// a rule is about a wait no check should sit through: the watcher down from the daemon's
// start, the snapshot's refusals, and the tab cards a list derives against mission records
// and boards. The routes, the board post's `session` and the no-name-on-disk rule are
// test/check-http.mjs's.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { boardLink, createSessionList, deriveTabs, DEFAULT_INTERVAL_MS, MAX_SESSIONS, MAX_NAME_CHARS } from '../src/sessions.mjs';
import { check, runMain } from './support.mjs';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const CANARY = 'SNAPSHOT-VALUE-CANARY';

function session(fields = {}) {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001', pid: 4242, procStart: '2026-10-29T11:10:15Z', kind: 'interactive',
    jobId: null, cwd: '/Users/pm/work/repo-a', login: '/Users/pm/.claude-a', name: '/grill tab capture', status: 'idle', reason: null,
    ...fields,
  };
}

function rig() {
  const clock = { t: T0 };
  let changes = 0;
  const list = createSessionList({ now: () => clock.t, onChange: () => { changes += 1; } });
  return { clock, list, changes: () => changes };
}

/** A board with one round asking a question, recorded as posted by `owner`. */
function questionBoard(owner, { sent = false, mission = null } = {}) {
  const board = createBoard({ title: 'a round', blocks: [{ kind: 'question', prompt: 'Go?', widget: 'single', options: [{ label: 'Yes' }] }] });
  board.session = owner;
  if (mission) board.mission = mission;
  if (sent) board.rounds[0].status = 'sent';
  return board;
}

async function main() {
  await check('the watcher reads up for two default intervals after the daemon starts with no snapshot, then down, published once', () => {
    const { clock, list, changes } = rig();
    try {
      assert.deepEqual(list.watcher(), { up: true, lastAt: null });
      clock.t = T0 + 2 * DEFAULT_INTERVAL_MS - 1;
      assert.equal(list.watcher().up, true);
      clock.t = T0 + 2 * DEFAULT_INTERVAL_MS;
      assert.deepEqual(list.watcher(), { up: false, lastAt: null });
    } finally {
      list.close();
    }
    assert.equal(changes(), 0, 'a read publishes nothing');
  });

  await check('a snapshot holds its sessions for two of its own intervals, then the list reads empty and down until the next one', () => {
    const { clock, list, changes } = rig();
    try {
      list.replace({ intervalMs: 5_000, sessions: [session()] });
      assert.equal(changes(), 1);
      list.replace({ intervalMs: 5_000, sessions: [session()] });
      assert.equal(changes(), 1, 'a snapshot repeating the last one publishes nothing');
      clock.t = T0 + 9_999;
      assert.equal(list.entries().length, 1);
      clock.t = T0 + 10_000;
      assert.deepEqual(list.entries(), []);
      assert.deepEqual(list.watcher(), { up: false, lastAt: new Date(T0).toISOString() });
      assert.equal(list.matchId(4242, '2026-10-29T11:10:15Z'), null, 'a dropped list resolves no round');
      list.replace({ intervalMs: 5_000, sessions: [session()] });
      assert.equal(list.watcher().up, true);
      assert.equal(changes(), 2, 'the watcher coming back up publishes, though the sessions repeat');
    } finally {
      list.close();
    }
  });

  await check('a malformed snapshot is refused whole with a 400 naming the field, never a value, and the list stays as it was', () => {
    const { list } = rig();
    try {
      list.replace({ intervalMs: 30_000, sessions: [session()] });
      const rows = [
        ['an unknown field', { intervalMs: 30_000, sessions: [{ ...session(), extra: CANARY }] }],
        ['an id off the pattern', { intervalMs: 30_000, sessions: [session({ id: `../${CANARY}` })] }],
        ['a pid with no process start', { intervalMs: 30_000, sessions: [session({ procStart: null, name: CANARY })] }],
        ['a process start with an offset, not UTC', { intervalMs: 30_000, sessions: [session({ procStart: '2026-10-29T13:10:15+02:00', name: CANARY })] }],
        ['no pid on a session that is not a blocked job', { intervalMs: 30_000, sessions: [session({ pid: null, procStart: null, name: CANARY })] }],
        ['a relative cwd', { intervalMs: 30_000, sessions: [session({ cwd: CANARY })] }],
        ['an unknown status', { intervalMs: 30_000, sessions: [session({ status: CANARY })] }],
        ['a name that is not a string', { intervalMs: 30_000, sessions: [session({ name: { CANARY } })] }],
        ['a repeated id', { intervalMs: 30_000, sessions: [session({ name: CANARY }), session({ pid: 4343 })] }],
        ['an interval under a second', { intervalMs: 999, sessions: [] }],
        ['too many sessions', { intervalMs: 30_000, sessions: Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => session({ id: `s${i}`, name: CANARY })) }],
      ];
      for (const [what, body] of rows) {
        let err;
        try {
          list.replace(body);
        } catch (e) {
          err = e;
        }
        assert.ok(err, `${what}: refused`);
        assert.equal(err.status, 400, `${what}: a 400`);
        assert.ok(!err.message.includes(CANARY), `${what}: the refusal echoes no value: ${err.message}`);
        assert.deepEqual(list.entries().map(e => e.id), [session().id], `${what}: the list is as it was`);
      }
    } finally {
      list.close();
    }
  });

  await check('a name or reason past its cap is cut to it, not refused; a blocked job with no process is listed', () => {
    const { list } = rig();
    try {
      list.replace({
        intervalMs: 30_000,
        sessions: [
          session({ name: 'x'.repeat(MAX_NAME_CHARS + 50) }),
          session({ id: 'job-session', pid: null, procStart: null, kind: 'bg', jobId: 'bc01dc2a', status: 'blocked', reason: 'usage limit until 15:00' }),
        ],
      });
      const [tab, job] = list.entries();
      assert.equal(tab.name, 'x'.repeat(MAX_NAME_CHARS));
      assert.equal(job.pid, null);
    } finally {
      list.close();
    }
  });

  await check('a pid resolves a session only together with its process start, and only when one session matches', () => {
    const { list } = rig();
    try {
      list.replace({
        intervalMs: 30_000,
        sessions: [session(), session({ id: 'other', pid: 5151, procStart: '2026-10-29T09:00:00Z' })],
      });
      assert.equal(list.matchId(4242, '2026-10-29T11:10:15.000Z'), session().id, 'the same instant, written with milliseconds');
      assert.equal(list.matchId(4242, '2026-10-29T11:10:15.400Z'), session().id, 'a start read to the millisecond matches one sent in whole seconds');
      assert.equal(list.matchId(4242, '2026-10-29T11:10:16Z'), null, 'a reused pid starts at another time');
      assert.equal(list.matchId(5151, '2026-10-29T11:10:15Z'), null);
    } finally {
      list.close();
    }
  });

  await check('a tab reads working when busy, waiting with your turn when idle, needs-you with its reason when blocked, and its command is its name\'s leading /word', () => {
    const tabs = deriveTabs({
      sessions: [
        session({ id: 'busy', status: 'busy', name: 'fix the flaky test' }),
        session({ id: 'idle', status: 'idle', name: '  /house:pr open it' }),
        session({ id: 'blocked', pid: null, procStart: null, kind: 'bg', jobId: 'bc01dc2a', status: 'blocked', reason: 'need you at browser', name: null }),
        session({ id: 'busy-reason', status: 'busy', reason: 'stale' }),
      ],
    });
    assert.deepEqual(tabs.map(t => [t.id, t.state, t.yourTurn, t.reason, t.command, t.folder]), [
      ['busy', 'working', false, null, null, 'repo-a'],
      ['idle', 'waiting', true, null, '/house:pr', 'repo-a'],
      ['blocked', 'needs-you', false, 'need you at browser', null, 'repo-a'],
      ['busy-reason', 'working', false, null, '/grill', 'repo-a'],
    ]);
  });

  await check('an open round on a board a tab posted puts it in needs-you, linked by its id, or by pid and process start when the board recorded no id or an id no listed session has', () => {
    const byId = session({ id: 'by-id', pid: 1001, procStart: '2026-10-29T10:00:00Z' });
    const byPid = session({ id: 'by-pid', pid: 1002, procStart: '2026-10-29T10:00:00Z' });
    const reused = session({ id: 'reused', pid: 1003, procStart: '2026-10-29T11:30:00Z' });
    const answered = session({ id: 'answered', pid: 1004, procStart: '2026-10-29T10:00:00Z' });
    const resumed = session({ id: 'resumed-new', pid: 1005, procStart: '2026-10-29T10:00:00Z' });
    const idBoard = questionBoard({ pid: 9999, procStart: '2026-10-29T08:00:00Z', id: 'by-id' });
    const pidBoard = questionBoard({ pid: 1002, procStart: '2026-10-29T10:00:00.000Z', id: null });
    const byIdToo = questionBoard({ pid: 1004, procStart: '2026-10-29T10:00:00Z', id: 'by-id' });
    // Resumed in place: the same process now lists under a new id.
    const resumedBoard = questionBoard({ pid: 1005, procStart: '2026-10-29T10:00:00Z', id: 'resumed-old' });
    const tabs = deriveTabs({
      sessions: [byId, byPid, reused, answered, resumed],
      boards: [
        idBoard,
        pidBoard,
        resumedBoard,
        // pid 1003 under its earlier process: the reused pid inherits nothing.
        questionBoard({ pid: 1003, procStart: '2026-10-29T07:00:00Z', id: null }),
        // pid 1004's process, but recorded under another listed session's id: that session's.
        byIdToo,
        questionBoard({ pid: 1004, procStart: '2026-10-29T10:00:00Z', id: 'answered' }, { sent: true }),
      ].map(boardLink),
    });
    assert.deepEqual(tabs.map(t => [t.id, t.state, t.rounds]), [
      ['by-id', 'needs-you', [{ board: idBoard.id, round: 1 }, { board: byIdToo.id, round: 1 }]],
      ['by-pid', 'needs-you', [{ board: pidBoard.id, round: 1 }]],
      ['reused', 'waiting', []],
      ['answered', 'waiting', []],
      ['resumed-new', 'needs-you', [{ board: resumedBoard.id, round: 1 }]],
    ]);
  });

  await check('a session a mission holds or held is no tab: its bound id or pid, the id or pid its last launch ended, a job id that is the bound id\'s first 8 characters, or a poster of a mission\'s board', () => {
    const bound = 'bc01dc2a-1111-4000-8000-000000000000';
    const reservedStart = '2026-10-29T10:30:00Z';
    // A launch reserves a session with no pid or id; until its first beat binds them, the
    // board it posts names its mission and its process.
    const reservedBoard = questionBoard({ pid: 3003, procStart: reservedStart, id: null }, { mission: 'D' });
    const handBoard = questionBoard({ pid: 4004, procStart: '2026-10-29T09:00:00Z', id: 'hand-tab' });
    const tabs = deriveTabs({
      sessions: [
        session({ id: bound, pid: 1 }),
        session({ id: 'job-of-bound', pid: 7, kind: 'bg', jobId: 'bc01dc2a' }),
        session({ id: 'ended-one', pid: 8 }),
        session({ id: 'cleared-anew', pid: 1 }),
        session({ id: 'ended-pid-anew', pid: 2 }),
        session({ id: 'reserved-one', pid: 3003, procStart: reservedStart }),
        session({ id: 'hand-tab', pid: 4004, procStart: '2026-10-29T09:00:00Z', jobId: 'ffff0000' }),
      ],
      missions: [
        { key: 'A', session: { pid: 1, id: bound } },
        { key: 'B', session: { startedAt: '2026-10-29T10:00:00Z', ended: { pid: 2, id: 'ended-one' } } },
        { key: 'C', session: null },
        { key: 'D', session: { startedAt: reservedStart, seenAt: reservedStart } },
      ],
      boards: [reservedBoard, handBoard].map(boardLink),
    });
    assert.deepEqual(tabs.map(t => [t.id, t.rounds]), [['hand-tab', [{ board: handBoard.id, round: 1 }]]]);
  });
}

runMain('sessions', main);
