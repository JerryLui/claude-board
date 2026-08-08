// Live-daemon checks for the pomodoro widget. Pure
// logic and DOM-stand-in-driven checks (markup, clock-offset arithmetic, the
// no-timer/running/paused renderings, pause/resume/reset button behaviour, the
// settings round trip, "never advances a phase on its own") live in
// test/check-pure.mjs. This file is for the one thing
// those cannot prove: that the widget's own fetch/postPomodoro calls actually
// authorise and round-trip against a REAL daemon over real HTTP, that a write
// really lands on disk (not just repaints the widget), and that two
// independently-loaded "tabs" against the SAME live daemon agree on the
// remaining time end to end -- including across a real daemon
// restart.
//
// Deliberately does NOT touch test/check-http.mjs or test/check-pomodoro.mjs
// (someone may still be pushing follow-ups to both) or src/pomodoro.mjs
// -- readDoc/writeDoc are imported read-only, the same ARRANGE-only use
// test/check-http.mjs's own pomodoro checks already make, never the assertion
// itself. Registered in test/run.mjs's `checks` array.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { readDoc as readPomodoroDoc, writeDoc as writePomodoroDoc, defaultDoc, localDateStr } from '../src/pomodoro.mjs';
import { cueNames, NO_CUE } from '../src/cues.mjs';
import { SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { renderIndexPage, indexScript } from '../src/indexpage.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-page-'));
const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'b'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

/** The cookie an authorized browser sends back, as a Cookie header value --
 * derived from the secret exactly as src/secret.mjs derives it, matching
 * test/check-http.mjs's own sessionCookieHeader(). This is what stands in here
 * for a real browser having already been through /auth/:token once. */
function sessionCookieHeader() {
  return `${SESSION_COOKIE}=${sessionToken(SECRET)}`;
}

/** Load the REAL renderIndexPage() output and run the REAL indexScript against
 * it, with globalThis.fetch rewritten to turn indexScript's relative
 * '/api/pomodoro...' calls into real requests against the live daemon on
 * 127.0.0.1:port, carrying the session-cookie header a real authorized browser
 * tab already holds. Node's fetch has no cookie jar of its own -- the widget's
 * own `credentials: 'same-origin'` does nothing outside a browser -- so
 * attaching the cookie by hand here is what makes this a faithful stand-in for
 * one. Captures every setInterval registration the same way
 * test/check-pure.mjs's own loadIndexWithPomodoro does, so a check can fire
 * tickPomodoro by hand instead of waiting on a real 1s/15s timer. */
// Captured ONCE, before anything ever stubs globalThis.fetch -- every install
// below rewrites relative to THIS, never to whatever happens to be installed
// at the moment (which would double-prefix the URL the second time two "tabs"
// are loaded back to back without an intervening restore -- caught by hand
// running this file: two tabs loaded one after another produced
// 'http://127.0.0.1:PORThttp://127.0.0.1:PORT/api/pomodoro').
const REAL_FETCH = globalThis.fetch;

function loadIndexAgainstDaemon(port) {
  const document = parseHTML(renderIndexPage({ threads: [] }));
  const intervals = [];
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.fetch = (url, opts) => {
    const target = `http://127.0.0.1:${port}${url}`;
    const headers = { ...(opts && opts.headers), cookie: sessionCookieHeader() };
    return REAL_FETCH(target, { ...opts, headers });
  };
  new Function('document', 'setInterval', indexScript)(document, fakeSetInterval);
  return {
    document,
    intervals,
    restoreFetch() { globalThis.fetch = REAL_FETCH; },
  };
}

/** A real network round trip against 127.0.0.1 settles in low single-digit ms,
 * but this is still real I/O, not a stubbed microtask (test/check-pure.mjs's
 * own flushPomodoro) -- 50ms is a generous, still-fast margin. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 50));
}

async function main() {
  let server = await startServer({ home, port: 0 });

  try {
    // ---------------------------------------------------------------------------
    // A running timer, seeded directly on disk -- every ASSERTION below still
    // goes through the real widget's real fetch/postPomodoro calls, this is
    // ARRANGE only (same discipline test/check-http.mjs's own pomodoro checks
    // already follow, per that file's own header comment).
    // ---------------------------------------------------------------------------
    const now = Date.now();
    // cycle: 2 (against the default settings' longEvery of 4) so the position half
    // of the status text is actually exercised end to end, not just the countdown --
    // the "Work 3/4 · 12:34" shape rides on these two checks rather than
    // earning new ones.
    const running = { ...defaultDoc(), cycle: 2, cycleDate: localDateStr(now), timer: { phase: 'work', deadline: now + 12 * 60_000, paused: false } };
    writePomodoroDoc(running, home);

    await check('pomodoro widget: GET /api/pomodoro over real HTTP, authorised by the session cookie alone (no secret header) -- exactly what a browser tab holds, position and all', async () => {
      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const status = tab.document.querySelector('span#pomodoro-status');
        assert.ok(status, 'setup failure: no #pomodoro-status rendered');
        assert.match(status.textContent, /^Work 3\/4 · \d\d:\d\d$/, `expected "Work 3/4 · mm:ss"-shaped text over real HTTP, got: "${status.textContent}"`);
      } finally {
        tab.restoreFetch();
      }
    });

    await check('pomodoro widget: two independently-loaded "tabs" against the SAME live daemon render the identical remaining time, position included', async () => {
      const tabA = loadIndexAgainstDaemon(server.port);
      const tabB = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const textA = tabA.document.querySelector('span#pomodoro-status').textContent;
        const textB = tabB.document.querySelector('span#pomodoro-status').textContent;
        assert.equal(textA, textB, 'two tabs independently fetching the same running timer from the same daemon must show the identical remaining time -- each computes its own clock offset from the daemon\'s own "now", so real per-tab timing jitter must not be visible at 1-second resolution');
        // Not just equal to each other -- actually the new position-carrying shape,
        // so this check cannot pass by both tabs agreeing on stale pre-position text.
        assert.match(textA, /^Work 3\/4 · \d\d:\d\d$/, `expected "Work 3/4 · mm:ss"-shaped text, got: "${textA}"`);
      } finally {
        tabA.restoreFetch();
        tabB.restoreFetch();
      }
    });

    await check('pomodoro widget: flipping the switch off while running posts through the cookie-authorised route and actually pauses the real document on disk', async () => {
      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const toggle = tab.document.querySelector('button#pomodoro-toggle');
        assert.equal(toggle.getAttribute('aria-checked'), 'true', 'setup failure: expected a running timer');
        toggle.dispatchEvent(new StandInEvent('click'));
        await flush();
        assert.equal(toggle.getAttribute('aria-checked'), 'false', 'the response must be applied back into the widget');
        const onDisk = readPomodoroDoc(home);
        assert.equal(onDisk.timer.paused, true, 'the click must have actually reached the daemon and paused the real document on disk, not merely repainted the widget');
        assert.equal(typeof onDisk.timer.remainingMs, 'number', 'a paused document must carry a frozen remainingMs (src/pomodoro.mjs pauseTimer)');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('pomodoro widget: flipping the switch back on while paused posts /api/pomodoro/resume and re-arms the daemon\'s own clock', async () => {
      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const toggle = tab.document.querySelector('button#pomodoro-toggle');
        assert.equal(toggle.getAttribute('aria-checked'), 'false', 'setup failure: expected the previous check to have left the timer paused');
        assert.equal(toggle.getAttribute('aria-label'), 'Resume pomodoro', 'paused reads off, but its label must say resume, not start');
        toggle.dispatchEvent(new StandInEvent('click'));
        await flush();
        assert.equal(toggle.getAttribute('aria-checked'), 'true');
        const onDisk = readPomodoroDoc(home);
        assert.equal(onDisk.timer.paused, false);
        assert.equal(typeof onDisk.timer.deadline, 'number', 'resuming must mint a fresh absolute deadline (src/pomodoro.mjs resumeTimer)');
      } finally {
        tab.restoreFetch();
      }
    });

    // The end-to-end half of "let me start one by hand": the cookie a browser tab
    // holds has to be enough to reach /api/pomodoro/ensure over real HTTP, and the
    // timer it starts has to actually land on disk. test/check-pure.mjs proves the
    // switch posts the right URL; only this proves the daemon accepts it.
    await check('pomodoro widget: flipping the switch on while idle starts a real timer on the daemon, authorised by the session cookie alone', async () => {
      writePomodoroDoc({ ...defaultDoc(), cycleDate: localDateStr(Date.now()) }, home);
      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const toggle = tab.document.querySelector('button#pomodoro-toggle');
        assert.equal(toggle.getAttribute('aria-checked'), 'false', 'setup failure: expected an idle daemon');
        assert.equal(toggle.getAttribute('aria-label'), 'Start pomodoro');
        toggle.dispatchEvent(new StandInEvent('click'));
        await flush();
        assert.equal(toggle.getAttribute('aria-checked'), 'true', 'the started timer must be applied back into the widget');
        const onDisk = readPomodoroDoc(home);
        assert.ok(onDisk.timer, 'a real timer must exist on disk -- the click must have reached the daemon, not merely repainted the switch');
        assert.equal(onDisk.timer.phase, 'work', 'starting by hand starts a WORK interval, exactly as the session-start hook does');
        assert.equal(onDisk.timer.paused, false);
      } finally {
        tab.restoreFetch();
      }
    });

    // Nine fields now, not six: the `sound` checkbox retired into three independent
    // per-phase cue pickers (ADR.md entry 20). Three
    // DIFFERENT names are chosen deliberately rather than three copies of one -- "each
    // remembers its own choice independently of the other two" is the criterion, and a
    // check that set all three alike would pass just as happily against a bug that
    // collapsed them into a single stored value. The names come off cueNames() rather
    // than being hardcoded, for the same reason src/pomodoro-widget.mjs builds its
    // options from it: this suite must not assert a 14-name list that is a property of
    // the machine it runs on.
    await check('pomodoro widget: the settings form posts through the cookie-authorised route and the daemon actually persists all nine fields, the three cues independently', async () => {
      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        // Skip NO_CUE at index 0 -- three real, distinct sounds is the stronger
        // arrangement, and `None` gets its own coverage in check-http/check-notify.
        const names = cueNames().filter(n => n !== NO_CUE);
        assert.ok(names.length >= 3, 'this machine must ship at least three system sounds for this check to mean anything');
        const [cueWork, cueBreak, cueLongBreak] = names;
        const form = tab.document.querySelector('form#pomodoro-settings-form');
        form.querySelector('input[name="workMin"]').value = '42';
        form.querySelector('input[name="breakMin"]').value = '7';
        form.querySelector('input[name="longBreakMin"]').value = '18';
        form.querySelector('input[name="longEvery"]').value = '5';
        form.querySelector('input[name="notify"]').checked = false;
        form.querySelector('select[name="cueWork"]').value = cueWork;
        form.querySelector('select[name="cueBreak"]').value = cueBreak;
        form.querySelector('select[name="cueLongBreak"]').value = cueLongBreak;
        form.dispatchEvent(new StandInEvent('submit'));
        await flush();
        const onDisk = readPomodoroDoc(home);
        assert.deepEqual(onDisk.settings, { workMin: 42, breakMin: 7, longBreakMin: 18, longEvery: 5, notify: false, cueWork, cueBreak, cueLongBreak }, 'all nine fields must actually persist on disk, exactly as entered');
        // Restated as its own assertion rather than left implicit in the deepEqual
        // above: the deepEqual would still pass if the three cues happened to be equal
        // AND the arrangement above had picked three equal names, so this pins the
        // property the criterion is actually about.
        assert.equal(new Set([onDisk.settings.cueWork, onDisk.settings.cueBreak, onDisk.settings.cueLongBreak]).size, 3, 'the three cues must land as three distinct stored values, not collapse into one');
        assert.ok(!('sound' in onDisk.settings), 'the retired sound key must not come back from a round trip through the real form');
      } finally {
        tab.restoreFetch();
      }
    });

    // ---------------------------------------------------------------------------
    // The daemon-restart half. test/check-pomodoro.mjs
    // already proves the DOCUMENT survives a restart; this proves the PAGE reads
    // it identically across one, through the real widget end to end.
    // ---------------------------------------------------------------------------
    await check('pomodoro widget: the rendered countdown survives a daemon restart -- same deadline, same offset math, same text (position included) on either side of it', async () => {
      const now2 = Date.now();
      // cycle: 1 -> position 2/4, so the restart proves the POSITION survives
      // reading `doc.cycle` back off disk, not only the countdown.
      const stable = { ...defaultDoc(), cycle: 1, cycleDate: localDateStr(now2), timer: { phase: 'break', deadline: now2 + 8 * 60_000, paused: false } };
      writePomodoroDoc(stable, home);

      const beforeTab = loadIndexAgainstDaemon(server.port);
      await flush();
      const before = beforeTab.document.querySelector('span#pomodoro-status').textContent;
      beforeTab.restoreFetch();
      assert.match(before, /^Break 2\/4 · \d\d:\d\d$/, `setup failure: expected "Break 2/4 · mm:ss"-shaped text before the restart, got "${before}"`);

      const port = server.port;
      await new Promise(resolve => server.server.close(resolve));
      server = await startServer({ home, port });

      const afterTab = loadIndexAgainstDaemon(server.port);
      await flush();
      const after = afterTab.document.querySelector('span#pomodoro-status').textContent;
      afterTab.restoreFetch();

      assert.equal(before, after, 'the same absolute deadline and the same cycle must render the identical text across a daemon restart -- the countdown and the position must not reset, jump, or go blank');
    });
  } finally {
    await new Promise(resolve => server.server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall pomodoro-page checks ok');
  });
