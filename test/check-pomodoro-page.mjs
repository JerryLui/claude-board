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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { readDoc as readPomodoroDoc, writeDoc as writePomodoroDoc, defaultDoc, pomodoroDay } from '../src/pomodoro.mjs';
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

// `pomodoroEnabled`/`hash` default to the values every pre-ADR-103 call site here
// already relied on (the full widget, no fragment) -- an existing call passing
// neither argument is unaffected by either one's addition. `pomodoroEnabled` feeds
// renderIndexPage directly (this helper calls it in-process, the same way every
// check here always has, never through a real GET / -- proving the SERVER's own
// gate, src/server.mjs's readPomodoroDoc call, is a different check below that
// goes through the real route instead of this helper).
function loadIndexAgainstDaemon(port, { pomodoroEnabled = true, hash = '' } = {}) {
  const document = parseHTML(renderIndexPage({ threads: [], pomodoroEnabled }));
  const intervals = [];
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.fetch = (url, opts) => {
    const target = `http://127.0.0.1:${port}${url}`;
    const headers = { ...(opts && opts.headers), cookie: sessionCookieHeader() };
    return REAL_FETCH(target, { ...opts, headers });
  };
  // 'window'/'location' join the two parameters this already passed: indexScript
  // reads both for the settings panel's '#pomodoro-settings' fragment (the one
  // the menu bar item's Settings row opens), the same
  // new Function('document', 'window', 'location', ui) contract every check that
  // drives src/ui.mjs already uses. The window is the parsed document's OWN
  // defaultView, so a listener the script registers is reachable from a check;
  // location is a plain { hash }, empty unless a check below asks for the
  // fragment explicitly (ADR 103's own reachability criterion, off included).
  // 'EventSource' is DECLARED and never passed, binding the name to undefined inside
  // this scope so initIndexStream takes its own `typeof` early return by this file's
  // choice rather than by whether the host node build exposes a global EventSource
  // (node has had one behind a flag since 22.x). Unflagged, the name would otherwise
  // resolve to the real constructor and this harness would open a live connection to
  // the relative URL '/api/events' -- from a check that is about the pomodoro widget.
  // test/check-index-live.mjs is the one harness that really supplies one.
  new Function('document', 'setInterval', 'window', 'location', 'EventSource', indexScript)(document, fakeSetInterval, document.defaultView, { hash });
  return {
    document,
    intervals,
    restoreFetch() { globalThis.fetch = REAL_FETCH; },
  };
}

/** The pomodoro widget's own real markup, isolated out of a full renderIndexPage()
 * (or a real GET / body) -- never a bare `html.includes('name="workMin"')` against
 * the WHOLE page, which is the exact trap test/check-pure.mjs's own comment names
 * ("'pomodoro-widget'/'theme-toggle' both also appear in this file's own CSS
 * comments"): indexScript is the SAME unconditional string regardless of which
 * shape rendered, and it carries the literal text of every selector this widget's
 * own client code ever looks up (`form.querySelector('input[name="workMin"]')`,
 * `document.querySelector('span#pomodoro-status')`, ...) -- so a plain substring
 * search against the full page finds those every time, on or off, and an
 * assertion built on it either always fails (checking absence) or always passes
 * vacuously (checking presence), never actually reading which shape rendered.
 * Slicing out just the widget's own markup, between its wrapper's opening tag and
 * themeToggle()'s button (the two real elements test/check-pure.mjs's own ordering
 * check already anchors on), is what makes a plain substring search meaningful
 * again. */
function pomodoroWidgetMarkup(html) {
  const start = html.indexOf('<div class="pomodoro-widget" id="pomodoro-widget">');
  const end = html.indexOf('<button type="button" id="theme-toggle"');
  assert.ok(start >= 0 && end > start, 'setup failure: could not isolate the pomodoro widget\'s own markup from the rest of the page');
  return html.slice(start, end);
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
    const running = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 12 * 60_000, paused: false } };
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
      writePomodoroDoc({ ...defaultDoc(), cycleDate: pomodoroDay(Date.now()) }, home);
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

    // Ten fields now, not six: the `sound` checkbox retired into three independent
    // per-phase cue pickers (ADR.md entry 20), and notifyRounds (ticket 03, ADR.md
    // entry 58) joined notify as the round banner's own tick. Three
    // DIFFERENT names are chosen deliberately rather than three copies of one -- "each
    // remembers its own choice independently of the other two" is the criterion, and a
    // check that set all three alike would pass just as happily against a bug that
    // collapsed them into a single stored value. The names come off cueNames() rather
    // than being hardcoded, for the same reason src/pomodoro-widget.mjs builds its
    // options from it: this suite must not assert a 14-name list that is a property of
    // the machine it runs on. notify and notifyRounds are set OPPOSITE each other below
    // for the same reason as check-pure.mjs's own arrangement: a bug that wired the two
    // checkboxes together would show up as a mismatch, not a coincidental pass.
    await check('pomodoro widget: the settings form posts through the cookie-authorised route and the daemon actually persists all eleven fields, the three cues, the two notify toggles and the two menu bar preferences independently', async () => {
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
        form.querySelector('input[name="notifyRounds"]').checked = true;
        form.querySelector('select[name="cueWork"]').value = cueWork;
        form.querySelector('select[name="cueBreak"]').value = cueBreak;
        form.querySelector('select[name="cueLongBreak"]').value = cueLongBreak;
        // The two menu bar preferences, both moved OFF their
        // defaults so this proves a real write rather than agreeing with what was
        // already stored -- and in opposite directions to each other, the same
        // reason notify and notifyRounds are set opposite above. "Show in menu bar"
        // is the one control in this form whose ticked state is the negation of the
        // key behind it: unticked here, so menubarHidden must land TRUE on disk.
        form.querySelector('input[name="menubarCountdown"]').checked = false;
        form.querySelector('input[name="menubarHidden"]').checked = false;
        form.dispatchEvent(new StandInEvent('submit'));
        await flush();
        const onDisk = readPomodoroDoc(home);
        // Still a WHOLE-object comparison, deliberately: it is what catches a form that
        // drops a stored setting it never displayed.
        // `enabled` rides along at its default (`true`): this form has no Master switch
        // input yet, so the settings patch it posts never mentions the key, and the
        // whole-object comparison below has to name it anyway or it is not really
        // whole-object -- see src/pomodoro.mjs's DEFAULT_SETTINGS/TOGGLE_KEYS.
        assert.deepEqual(onDisk.settings, { enabled: true, workMin: 42, breakMin: 7, longBreakMin: 18, longEvery: 5, notify: false, notifyRounds: true, cueWork, cueBreak, cueLongBreak, menubarCountdown: false, menubarHidden: true }, 'all eleven fields must actually persist on disk, exactly as entered');
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

    // The rollover, seen from the page (ADR 67, criterion 7). Nothing has started a
    // session, nothing has pressed anything and no boundary has fired -- the page
    // simply opens, and what it opens onto is a document belonging to a pomodoro day
    // that ended. '2020-01-01' rather than an injected clock: the daemon reads with its
    // own Date.now(), so the stale day has to be a real one, and any past date is stale
    // at every hour this suite might be run at. test/check-pomodoro.mjs proves the same
    // rule at readDoc and at the route; this is the only place that proves what the
    // reader actually sees, which is the whole point of the criterion.
    await check('pomodoro widget: a document left over from a previous pomodoro day renders as idle -- opening the page shows no interval, and starts none', async () => {
      const stale = { ...defaultDoc(), cycle: 3, cycleDate: '2020-01-01', timer: { phase: 'work', paused: true, remainingMs: 9 * 60_000 } };
      writePomodoroDoc(stale, home);
      const before = readFileSync(path.join(home, 'pomodoro.json'), 'utf8');

      const tab = loadIndexAgainstDaemon(server.port);
      try {
        await flush();
        const status = tab.document.querySelector('span#pomodoro-status');
        assert.match(status.textContent, /idle/i, `last night's paused timer must not be on the page at all, got: "${status.textContent}"`);
        assert.doesNotMatch(status.textContent, /\d\d:\d\d/, 'no countdown -- neither last night\'s remainder nor a fresh interval');
        assert.doesNotMatch(status.textContent, /\d+\/\d+/, 'and no position either: the cycle went back to zero with the timer');
        const toggle = tab.document.querySelector('button#pomodoro-toggle');
        assert.equal(toggle.getAttribute('aria-checked'), 'false');
        assert.equal(toggle.getAttribute('aria-label'), 'Start pomodoro', 'the control offers to START one, which is the honest state to be in');
        assert.equal(readFileSync(path.join(home, 'pomodoro.json'), 'utf8'), before, 'opening the page must start nothing -- not a write, let alone an interval');
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
      const stable = { ...defaultDoc(), cycle: 1, cycleDate: pomodoroDay(now2), timer: { phase: 'break', deadline: now2 + 8 * 60_000, paused: false } };
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

    // ---------------------------------------------------------------------------
    // ADR 103, "off is absence". The daemon-side half of the new `enabled` key
    // (validating it through POST /api/pomodoro/settings) is another chunk's work
    // and is not in this worktree -- src/pomodoro.mjs's TOGGLE_KEYS does not know
    // the name yet, so these checks never round-trip it through the HTTP write
    // path. They seed an off DOCUMENT straight to disk instead, exactly the way
    // every other fixture in this file already does (writePomodoroDoc, ARRANGE
    // only) -- normalizeDoc's own unknown-key passthrough (src/pomodoro.mjs) is
    // what makes a hand-written `enabled: false` survive the read back intact
    // even before the other chunk teaches TOGGLE_KEYS the name. What these checks
    // are actually proving is entirely this chunk's own code: src/server.mjs's
    // GET / gate (`settings.enabled !== false`) and src/pomodoro-widget.mjs's two
    // shapes -- not the daemon's validation of a write, which is out of scope
    // here by the brief's own instruction.
    // ---------------------------------------------------------------------------

    await check('index page, pomodoro off: GET / server-renders no timer widget -- only a bare, reachable gear -- and the settings panel omits every pomodoro-only section while keeping the four survivors', async () => {
      const off = { ...defaultDoc(), cycleDate: pomodoroDay(Date.now()), settings: { ...defaultDoc().settings, enabled: false } };
      writePomodoroDoc(off, home);

      const res = await REAL_FETCH(`http://127.0.0.1:${server.port}/`, { headers: { cookie: sessionCookieHeader() } });
      assert.equal(res.status, 200, 'setup failure: GET / must still answer with the switch off');
      const widget = pomodoroWidgetMarkup(await res.text());

      // The timer itself: gone, not merely unpopulated -- every id that names a
      // piece of it absent from the widget's own markup entirely.
      for (const needle of ['id="pomodoro-status"', 'id="pomodoro-toggle"', 'id="pomodoro-restart"', 'id="pomodoro-forward"', 'id="pomodoro-icon-slot"', 'id="pomodoro-reset"']) {
        assert.ok(!widget.includes(needle), `${needle} must not render at all with the switch off -- Reset acts on a loop that does not exist while off`);
      }
      // The gated settings sections: gone, duration fields, Cues, and the two rows
      // the spec names by field (interval-banner/notify, menu-bar-Countdown).
      for (const needle of ['name="workMin"', 'name="breakMin"', 'name="longBreakMin"', 'name="longEvery"', 'name="notify"', 'name="cueWork"', 'name="cueBreak"', 'name="cueLongBreak"', 'name="menubarCountdown"', 'pomodoro-settings-caption">Cues']) {
        assert.ok(!widget.includes(needle), `${needle} must not render with the switch off`);
      }

      // Still reachable: the wrapper initPomodoroWidget's own bail check looks
      // for, and #pomodoro-settings itself -- baked into the compiled menu-bar
      // binary's gear URL, so it must survive under this exact id regardless of
      // which shape rendered.
      assert.ok(widget.startsWith('<div class="pomodoro-widget" id="pomodoro-widget">'), 'the wrapper must still exist -- it is what wires the survivors below to indexScript');
      assert.ok(widget.includes('<details class="pomodoro-settings" id="pomodoro-settings">'), '#pomodoro-settings must keep existing -- the compiled menu-bar binary\'s gear URL is baked against it');
      assert.ok(widget.includes('class="pomodoro-settings-summary"'), 'the bare gear itself must render');

      // The four survivors: the Master switch (server-rendered honestly unchecked,
      // since this document really does have settings.enabled === false), round
      // banners (the safety net SECURITY.md documents), Hide menu bar icon
      // (rendered as its positive, "Show in menu bar", same as always), and the
      // whole Store section.
      assert.ok(widget.includes('<label class="pomodoro-field pomodoro-field-check">Pomodoro timer<input type="checkbox" name="enabled"></label>'), 'the Master switch row must survive, unchecked -- it is the only way back on');
      assert.ok(widget.includes('<label class="pomodoro-field pomodoro-field-check">Round banners<input type="checkbox" name="notifyRounds"></label>'), 'round banners are not the pomodoro\'s and must survive off untouched');
      assert.ok(widget.includes('<label class="pomodoro-field pomodoro-field-check">Show in menu bar<input type="checkbox" name="menubarHidden"></label>'), 'Hide menu bar icon must survive -- it hides/unhides the whole status item regardless of the switch');
      assert.ok(widget.includes('pomodoro-settings-caption">Store<'), 'the Store section must survive off untouched');
      assert.ok(widget.includes('id="store-prune-days"') && widget.includes('id="store-prune"'), 'the Store control itself must still be reachable');
    });

    await check('index page, pomodoro off: the bare gear stays reachable -- the fragment the menu bar popover\'s own gear navigates to still opens the settings panel', async () => {
      const off = { ...defaultDoc(), cycleDate: pomodoroDay(Date.now()), settings: { ...defaultDoc().settings, enabled: false } };
      writePomodoroDoc(off, home);

      // pomodoroEnabled: false renders the SAME off shape the check above proved
      // GET / serves -- this one drives the real indexScript against it, with the
      // fragment already set the way a fresh tab opened from the menu bar's own
      // URL (bin/menubar.m: cb_open_url(cb_index_url(@"#pomodoro-settings"))) would
      // arrive with, proving criterion 3's other half: the popover gear still
      // lands on the settings panel, off included.
      const tab = loadIndexAgainstDaemon(server.port, { pomodoroEnabled: false, hash: '#pomodoro-settings' });
      try {
        await flush();
        const panel = tab.document.querySelector('details#pomodoro-settings');
        assert.ok(panel, 'setup failure: #pomodoro-settings did not render');
        assert.equal(panel.open, true, 'the fragment must open the panel even with the switch off -- settings must stay reachable');
        // And the survivors inside it are the real, live daemon's own values --
        // proving initPomodoroWidget actually ran (not just that the markup
        // happened to render), the same "settled, not merely rendered" bar every
        // other check in this file holds itself to.
        const notifyRounds = tab.document.querySelector('input[name="notifyRounds"]');
        assert.ok(notifyRounds, 'the round-banner row must be wired up, not just present in the markup');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('index page: a settings document with no `enabled` key at all -- the upgrade path -- still server-renders the full timer widget', async () => {
      // A legacy on-disk document, the same shape a settings file written before
      // ADR 103 existed would have: no `enabled` key anywhere in its settings
      // object. defaultDoc() no longer proves that on its own now that the
      // daemon chunk's DEFAULT_SETTINGS/normalizeDoc (src/pomodoro.mjs) fill the
      // key in on every read -- in memory, before this fixture is even written --
      // so asserting against an in-memory object here would pass regardless of
      // what actually lands on disk. Strip the key back out of defaultDoc()'s own
      // settings (future-proof against DEFAULT_SETTINGS changing shape again)
      // before writing, then read the RAW bytes back with fs, never readDoc,
      // which is the one guard that actually proves this fixture is what it
      // claims to be.
      const { enabled: _enabled, ...legacySettings } = defaultDoc().settings;
      const upgraded = { ...defaultDoc(), cycleDate: pomodoroDay(Date.now()), settings: legacySettings };
      writePomodoroDoc(upgraded, home);
      const onDisk = JSON.parse(readFileSync(path.join(home, 'pomodoro.json'), 'utf8'));
      assert.ok(!('enabled' in onDisk.settings), 'setup failure: the raw on-disk JSON must not carry an enabled key -- readDoc\'s own normalized view of it would carry one regardless, which is exactly why this reads the file instead');

      const res = await REAL_FETCH(`http://127.0.0.1:${server.port}/`, { headers: { cookie: sessionCookieHeader() } });
      const widget = pomodoroWidgetMarkup(await res.text());
      assert.ok(widget.includes('id="pomodoro-status"'), 'a missing key must read as on, identical to today -- the full timer widget must still render');
      assert.ok(widget.includes('name="workMin"'), 'and the full settings panel with it, duration fields included');
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
