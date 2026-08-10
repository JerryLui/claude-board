// The CLIENT half of the attended report and the banner's click sentinel
// (SPEC_STRANDED.md tickets 02/06, ADR.md entry 58), driven for real: the real
// `ui` script running against test/dom-stand-in.mjs, exactly as
// test/check-round-pager.mjs and four other check files already do, with
// `globalThis.fetch` stubbed to capture what reportAttended actually posts and
// `StandInEventSource.dispatch` standing in for the daemon's own SSE pushes.
//
// A six-pass audit of SPEC_STRANDED.md found reportAttended and isTabAttended
// were never EXECUTED by any check -- test/check-pure.mjs only pattern-matches
// their source text -- and the 'watcher' SSE event was never dispatched either,
// though the machinery for it (StandInEventSource.dispatch) was already
// established elsewhere in the suite. That gap is exactly why a missing 'blur'
// listener (the board's main scenario: left open on one screen while the
// reviewer works in another window) shipped and stayed green. This file closes
// it: every check below fails on the pre-fix code.

import assert from 'node:assert/strict';
import { createBoard, addRound } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent, StandInEventSource, StandInHistory } from './dom-stand-in.mjs';

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

const Q = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };

/** Loads the real `ui` script against a real board document, capturing the
 * EventSource it constructs so a check can `es.dispatch(...)` the daemon's own
 * pushes into it -- test/check-round-pager.mjs's `loadBoardWithEventSource`,
 * copied rather than imported (no shared test-helper module in this repo, by
 * convention: see that file's own header comment). */
function loadBoardWithEventSource(html) {
  const originalES = globalThis.EventSource;
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  globalThis.EventSource = CapturingEventSource;
  try {
    const document = parseHTML(html);
    const window = document.defaultView;
    const location = { protocol: 'http:', hash: '' };
    new Function('document', 'window', 'location', ui)(document, window, location);
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
    return { document, window, location, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
}

/** Stubs `fetch`, capturing every call's URL and parsed JSON body. Restore is
 * the caller's job (a `finally`), matching every other fetch stub in this
 * suite (test/check-round-pager.mjs, test/check-send-guard.mjs). */
function stubFetch(respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return respond ? respond() : Promise.resolve({ ok: true });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// --- The attended report itself ----------------------------------------------

await check('the watcher id arriving over SSE fires an immediate report, before any visibility/focus/blur edge', async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { es } = loadBoardWithEventSource(renderBoardPage(board));
  const { calls, restore } = stubFetch();
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    assert.equal(calls.length, 1, "the 'watcher' event must trigger an immediate report -- a tab opened straight into the background never fires visibilitychange/focus/blur on its own");
    assert.equal(calls[0].url, `/api/board/${board.id}/attended`);
    assert.deepEqual(calls[0].body, { watcher: 'w1', attended: true, seq: 1 }, 'a freshly opened, visible tab must report attended: true, with its ordering seq -- the daemon has no other way to tell two in-flight reports for the same watcher apart');
  } finally { restore(); }
});

await check("blur -- the tab stays VISIBLE, only loses focus to another window -- reports attended: false; this is the product's main stranded scenario (SPEC_STRANDED.md criterion 3), and before the fix, nothing reported it at all", async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  let focused = true;
  // document.hidden stays false throughout this check -- a plain blur never
  // touches it in a real browser either, which is exactly why visibilitychange
  // alone cannot see this edge. hasFocus() is a plain method on the stand-in's
  // document prototype (always true there); shadowing it with an own property
  // is ordinary JS and needs no change to test/dom-stand-in.mjs.
  document.hasFocus = () => focused;
  // Stubbed BEFORE the 'watcher' dispatch, not after: that dispatch fires the
  // initial report synchronously, and an unstubbed fetch there is a REAL
  // request against a relative URL with no server behind it -- harmless noise
  // against the old bounded (2-retry) reportAttended, but against the
  // unbounded one below it arms a REAL, never-cancelled setTimeout chain
  // that outlives this check and keeps the whole process alive. Found by the
  // suite hanging after this rewrite, not by inspection.
  const { calls, restore } = stubFetch();
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    assert.equal(document.hidden, false, 'setup sanity: the tab must stay visible for this to be the blur scenario, not the hidden-tab one');
    focused = false;
    window.dispatchEvent(new StandInEvent('blur'));
    assert.equal(calls.length, 2, "the initial watcher report plus the blur report -- losing focus (document stays visible, document.hidden false) must trigger a fresh report -- a board left open on one screen while the reviewer works in another window or the terminal is the single most common posture this product has, and reportAttended used to have no way to hear about it at all");
    const blurBody = calls[1].body;
    assert.equal(blurBody.watcher, 'w1');
    assert.equal(blurBody.attended, false, 'attended must read false once focus has moved elsewhere');
    assert.equal(blurBody.seq, 2, 'carrying a seq strictly greater than the watcher report -- the daemon needs that ordering to resist the blur POST landing on a second connection ahead of an earlier one');
    // The look-away window's own half (ADR 73). The daemon's record of when a tab last
    // had focus lives on the SSE Watcher, and a reconnect mints a fresh one -- so the tab
    // has to be able to say how long ago it last had focus, or a daemon restart under a
    // buried tab costs the reviewer the whole window and raises a banner for a board they
    // were looking at seconds ago.
    assert.ok(Number.isInteger(blurBody.sinceFocusMs) && blurBody.sinceFocusMs >= 0,
      `a blur must carry how long ago this tab last had focus, got ${JSON.stringify(blurBody.sinceFocusMs)}`);
    assert.ok(blurBody.sinceFocusMs < 1000, 'and it has only just lost it, so that is a very small number');
  } finally { restore(); }
});

await check('sinceFocusMs measures from when focus was LOST, not from when it was gained -- the ordinary posture is a board read for a long stretch and then buried', async () => {
  // The assertion above cannot see this: it blurs in the same millisecond as the watcher
  // report, so "time since focus was gained" and "time since focus was lost" are the same
  // number and a wrong implementation passes. This one reads the board for a while first.
  //
  // Reports are edge-driven, so nothing is sent during that stretch -- which is exactly
  // why the tab cannot stamp only when a report says it IS focused. Getting this wrong
  // costs the whole look-away window for anyone who reads a board for longer than two
  // minutes before switching to the terminal, which is the posture the window exists for.
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  let focused = true;
  document.hasFocus = () => focused;
  const { calls, restore } = stubFetch();
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    assert.equal(calls[0].body.attended, true, 'setup sanity: the reviewer is looking at it');

    const READING_MS = 250; // a stretch of reading, with no DOM edge and so no report
    await new Promise(r => setTimeout(r, READING_MS));
    assert.equal(calls.length, 1, 'setup sanity: nothing is reported while the tab just sits there focused');

    focused = false;
    window.dispatchEvent(new StandInEvent('blur'));
    const blur = calls[1].body;
    assert.ok(blur.sinceFocusMs < READING_MS / 2,
      `a tab that has just lost focus last had it ~now, not ${READING_MS}ms ago: got ${blur.sinceFocusMs}`);

    // And the reconnect leg, which is the one the field exists for: the report a fresh
    // Watcher gets must measure from the BLUR, so the daemon seeds what is genuinely left
    // of the window rather than one already spent by the time spent reading.
    const AWAY_MS = 120;
    await new Promise(r => setTimeout(r, AWAY_MS));
    es.dispatch('watcher', JSON.stringify({ id: 'w2' })); // EventSource reconnected
    const reconnect = calls[calls.length - 1].body;
    assert.equal(reconnect.watcher, 'w2', 'setup sanity: this is the reconnect report');
    assert.ok(reconnect.sinceFocusMs >= AWAY_MS * 0.5 && reconnect.sinceFocusMs < READING_MS,
      `the reconnect must report the time spent AWAY (~${AWAY_MS}ms), not away plus the time spent reading (~${READING_MS + AWAY_MS}ms): got ${reconnect.sinceFocusMs}`);
  } finally { restore(); }
});

await check('a report that says the tab IS focused carries no sinceFocusMs, and one from a tab that never had focus carries none either', async () => {
  // Two absences, and both are deliberate. A tab that has focus right now says the
  // stronger thing already, so the field would be noise. A tab that has NEVER had focus
  // has nothing to report, and sending zero would hand it a full look-away window it has
  // not earned -- "connected implies recently focused" is the reading ADR 73 refuses.
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  const { calls, restore } = stubFetch();
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    assert.ok(!('sinceFocusMs' in calls[0].body), `a focused report must not carry it: ${JSON.stringify(calls[0].body)}`);
    restore();
  } finally { restore(); }

  const other = createBoard({ title: 'y', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const buried = loadBoardWithEventSource(renderBoardPage(other));
  buried.document.hasFocus = () => false;
  const { calls: buriedCalls, restore: restoreBuried } = stubFetch();
  try {
    // A tab that opened straight into the background: its very first report is `false`,
    // and it has no focus of its own to date.
    buried.es.dispatch('watcher', JSON.stringify({ id: 'w2' }));
    assert.equal(buriedCalls[0].body.attended, false, 'setup sanity: this tab really is unfocused');
    assert.ok(!('sinceFocusMs' in buriedCalls[0].body),
      `a tab that has never had focus must send nothing: ${JSON.stringify(buriedCalls[0].body)}`);
  } finally { restoreBuried(); }
});

await check('regaining focus after a blur reports attended: true again, through the SAME listener pair blur uses', async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  let focused = true;
  document.hasFocus = () => focused;
  // Stubbed before ANY dispatch, for the same reason as the check above.
  const { calls, restore } = stubFetch();
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    focused = false;
    window.dispatchEvent(new StandInEvent('blur'));
    focused = true;
    window.dispatchEvent(new StandInEvent('focus'));
    assert.equal(calls.length, 3, 'watcher, then blur, then focus -- three reports in sequence');
    assert.deepEqual(calls[2].body, { watcher: 'w1', attended: true, seq: 3 });
  } finally { restore(); }
});

/** Runs setTimeout callbacks IMMEDIATELY, synchronously, rather than waiting on
 * the real clock -- this repo's own convention for a fast-forwarded retry
 * check (see the coverage for reportAttended's earlier bounded version, and
 * the check below it that supersedes this one). Also records every requested
 * delay, so a check can assert on the SHAPE of the backoff (growing, then
 * capped), not just that a retry happened at all. */
function fastForwardSetTimeout() {
  const original = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, delay) => { delays.push(delay); fn(); return 0; };
  return { delays, restore: () => { globalThis.setTimeout = original; } };
}

await check('a focused tab whose attended reports keep failing retries UNBOUNDED -- not a fixed count -- at a growing but capped delay, until one finally lands, with no DOM edge required', async () => {
  // The scenario the coordinator named directly: a visible, focused tab earns
  // no further visibility/focus/blur edge on its own (the reviewer is already
  // looking and has no reason to touch it), so a fixed retry count just moves
  // the mute hole from "one dropped POST" to "N dropped POSTs" -- worse now
  // that isAttended no longer tolerates a Watcher that has never successfully
  // reported at all, which is exactly what a daemon-restart storm (failures
  // clustering) produces.
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { es } = loadBoardWithEventSource(renderBoardPage(board));
  const { delays, restore: restoreTimeout } = fastForwardSetTimeout();
  const FAIL_COUNT = 6; // past the point the backoff must have hit its ceiling
  let attempts = 0;
  const { calls, restore: restoreFetch } = stubFetch(() => {
    attempts++;
    return attempts <= FAIL_COUNT ? Promise.reject(new Error('network down')) : Promise.resolve({ ok: true });
  });
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    await flushMicrotasks(200);
    assert.equal(calls.length, FAIL_COUNT + 1, `expected ${FAIL_COUNT} failures plus the report that finally lands, got ${calls.length} call(s)`);
    assert.deepEqual(calls[calls.length - 1].body, { watcher: 'w1', attended: true, seq: 1 }, 'the report that finally lands must still carry the CURRENT state, not a stale snapshot from the first attempt');
    assert.ok(calls.every(c => c.body.seq === 1), 'every retry in ONE chain must carry the SAME seq it was minted under -- the value captured for that send, not attendedEpoch read fresh at send time, or a retry would claim to be a NEWER report than the state it is actually resending');
    assert.equal(delays.length, FAIL_COUNT, 'exactly one retry timer per failure, and none at all after the report that landed -- idle the instant a report succeeds');
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], `the delay must never SHRINK between successive retries: ${delays.join(', ')}`);
    }
    assert.ok(delays[0] < delays[delays.length - 1], `the backoff must actually grow, not fire at one fixed interval: ${delays.join(', ')}`);
    assert.ok(delays.every(d => d <= 15000), `every delay must stay at or under the SSE heartbeat ceiling this connection already pays for (15s default), got ${delays.join(', ')}`);
    assert.ok(delays.some(d => d === 15000), `the backoff must actually REACH its ceiling by the sixth failure, not merely stay under it: ${delays.join(', ')}`);
  } finally { restoreTimeout(); restoreFetch(); }
});

await check("an HTTP-level rejection -- a 401 mid secret-rotation, a 5xx, anything not ok -- is treated as a failed report and retried exactly like a dropped one. fetch()'s own promise only rejects on a NETWORK failure; a non-2xx response resolves normally, so without an explicit check the daemon recording nothing reads to the page as indistinguishable from success and nothing would ever retry", async () => {
  // The scenario: the secret file is rotated or briefly unreadable during a
  // partial install.sh run. The SSE stream survives on heartbeats (it was
  // authorized at open), so the tab stays a Watcher -- but every attended
  // report it sends from here on 401s. The unbounded-retry argument two
  // checks up ("a focused tab earns no further edge to retry on its own")
  // applies to this exact shape too: a rejected response is not a lost
  // packet, but it is just as silent from the reviewer's side.
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { es } = loadBoardWithEventSource(renderBoardPage(board));
  const { delays, restore: restoreTimeout } = fastForwardSetTimeout();
  const REJECT_COUNT = 3;
  let attempts = 0;
  const { calls, restore: restoreFetch } = stubFetch(() => {
    attempts++;
    // Every one of these RESOLVES -- fetch() itself never rejects here at
    // all, unlike the check above -- exactly what a real 401/5xx looks like
    // to the caller, as opposed to a dropped connection.
    return Promise.resolve(attempts <= REJECT_COUNT ? { ok: false, status: 401 } : { ok: true });
  });
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    await flushMicrotasks(50);
    assert.equal(calls.length, REJECT_COUNT + 1, `expected ${REJECT_COUNT} rejected responses plus the one that finally lands, got ${calls.length} call(s)`);
    assert.equal(delays.length, REJECT_COUNT, 'a non-2xx response must arm a retry exactly like a dropped one -- none of these ever hit fetch()\'s own .catch, only the added ok-check should be arming them');
  } finally { restoreTimeout(); restoreFetch(); }
});

/** Schedules setTimeout callbacks WITHOUT running them, so a check can dispatch
 * a fresh edge while a retry is still pending and observe whether it survives
 * -- the opposite of fastForwardSetTimeout's job just above, and needed
 * because "does the pending retry get cancelled" is unobservable if it always
 * fires the instant it is scheduled. */
function controllableSetTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextId = 1;
  const pending = new Map();
  const cleared = [];
  globalThis.setTimeout = (fn, delay) => { const id = nextId++; pending.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => { cleared.push(id); pending.delete(id); };
  return {
    pending, cleared,
    restore: () => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; },
  };
}

await check("a pending retry from a STALE call never fires its own duplicate report once a fresher edge has reported on its own -- superseded by a monotonic epoch, not by cancelling a timer handle: a single handle cannot track more than one in-flight chain, and more than one CAN be in flight at once (the next check proves exactly that)", async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  document.hasFocus = () => true;
  const timers = controllableSetTimeout();
  let rejectNext = true;
  const { calls, restore: restoreFetch } = stubFetch(() => (rejectNext ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true })));
  try {
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'setup: the initial report must have gone out and failed');
    assert.equal(timers.pending.size, 1, 'setup: exactly one retry timer must be armed after that failure');
    const [staleId, staleEntry] = [...timers.pending][0];

    rejectNext = false; // the fresh edge's own report will land
    window.dispatchEvent(new StandInEvent('focus'));
    assert.equal(calls.length, 2, "the fresh edge's own report must have gone out immediately");
    await flushMicrotasks();
    assert.equal(calls.length, 2, 'the fresh report must have succeeded, arming no retry of its own');

    // Nothing cancelled the STALE timer above -- it is still sitting in
    // `pending`, exactly as a real browser's setTimeout would still be live.
    // Firing it must be a no-op: its own epoch no longer matches the current
    // one, so it must send no duplicate POST and arm no retry of its own.
    timers.pending.delete(staleId);
    staleEntry.fn();
    await flushMicrotasks();
    assert.equal(calls.length, 2, 'a stale retry firing after a fresher edge already reported must never send a duplicate POST');
    assert.equal(timers.pending.size, 0, 'and must never arm a further retry of its own either');
  } finally { restoreFetch(); timers.restore(); }
});

await check("an alt-tab burst -- focus, blur, focus, blur, all within milliseconds, EVERY one of the four POSTs genuinely in flight together before any has rejected -- arms exactly ONE retry timer once they all reject, not one per in-flight POST, and keeps sending exactly one report per interval afterward. This is the exact defect a coordinator's review found in the first version of this fix: attendedRetryTimer held one handle, but a burst like this starts a new POST every time because 'none of the earlier fetches has rejected yet', so each of the four catches independently armed its OWN retry, clobbering the same one variable and leaking three chains", async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const { document, window, es } = loadBoardWithEventSource(renderBoardPage(board));
  let focused = true;
  document.hasFocus = () => focused;
  const timers = controllableSetTimeout();
  // The daemon is down for the few seconds this burst happens in -- every
  // report, first attempt and every retry alike, rejects.
  const { calls, restore: restoreFetch } = stubFetch(() => Promise.reject(new Error('daemon down')));
  try {
    // Four edges, back to back, with NO microtask flush between them: the
    // defining shape of the bug. reportAttended is called four times before
    // ANY of the four fetch()es it starts has had a chance to reject, so at
    // the moment each one starts there is nothing yet for a single timer
    // handle to have "already armed" -- the alt-tab burst this listener
    // exists to catch in the first place (SPEC_STRANDED.md criterion 3).
    es.dispatch('watcher', JSON.stringify({ id: 'w1' }));
    focused = false; window.dispatchEvent(new StandInEvent('blur'));
    focused = true; window.dispatchEvent(new StandInEvent('focus'));
    focused = false; window.dispatchEvent(new StandInEvent('blur'));
    assert.equal(calls.length, 4, 'setup: all four reports must have gone out -- none skipped or debounced at SEND time, only the RETRY after they all fail must collapse');

    await flushMicrotasks(); // all four in-flight fetches reject here together
    assert.equal(timers.pending.size, 1, `exactly ONE retry timer may be armed once all four in-flight POSTs reject, not one per POST -- got ${timers.pending.size}`);

    // Fire that one retry and let it fail again -- still exactly one more
    // timer, never a second stacking on top of it.
    const [[fireId, fireEntry]] = timers.pending;
    timers.pending.delete(fireId);
    fireEntry.fn();
    await flushMicrotasks();
    assert.equal(calls.length, 5, 'the one armed retry must have sent exactly one more report');
    assert.equal(timers.pending.size, 1, 'and armed exactly one more retry timer -- still never more than one live at a time, however many times it fails');
  } finally { restoreFetch(); timers.restore(); }
});

await check('readonly mode never reports, even with a watcher id and a real blur', async () => {
  const board = createBoard({ title: 'x', blocks: [{ kind: 'markdown', text: '# hi' }] });
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  const location = { protocol: 'file:' };
  const { calls, restore } = stubFetch();
  try {
    // EventSource is never opened in readonly mode (guarded in src/ui.mjs), so
    // there is no 'watcher' event to dispatch here at all -- the archive simply
    // never subscribes. This proves the SILENCE, not a code path that fires
    // and is then swallowed.
    new Function('document', 'window', 'location', ui)(document, window, location);
    window.dispatchEvent(new StandInEvent('blur'));
    window.dispatchEvent(new StandInEvent('focus'));
    document.dispatchEvent(new StandInEvent('visibilitychange'));
    assert.equal(calls.length, 0, 'a standalone file:// archive must never POST an attended report');
  } finally { restore(); }
});

// --- The banner's own click sentinel, '#stranded-round' ----------------------

/** round 1: still genuinely awaited. round 2: minted awaited (a question round
 * always is) then manually lapsed -- the exact shape closeLapsedAwaitedRounds
 * (src/badge.mjs) leaves behind once a wait's own deadline passes: `awaited:
 * false`, `status` still 'open'. round 2 is therefore the LATEST unsent round
 * (what openRoundNumber() and '#open-round' correctly resolve to) while round
 * 1 is the OLDEST one still actually awaited -- the case criterion 12 and
 * ADR.md entry 58's Decisions name explicitly: "the click resolves to the
 * oldest round still waiting", and a lapsed round must never outrank an older
 * one still genuinely awaited. */
function oldestAwaitedNotNewestBoard() {
  const board = createBoard({ title: 'Stranded', blocks: [Q] });
  addRound(board, { title: 'Second', blocks: [Q] });
  const lapsed = board.rounds[1];
  assert.equal(lapsed.awaited, true, 'setup sanity: a question round is always minted awaited');
  lapsed.awaited = false; // simulates its own deadline having already passed
  return board;
}

/** The other direction, and the ordinary one: round 1 ANSWERED, round 2 still
 * awaited. applySubmit (src/board.mjs) stamps `status: 'sent'` and deliberately
 * leaves `awaited: true` standing, so the bare `roundIsAwaited` flag still reads
 * true for a round the reviewer has already dealt with. Every board past its
 * first exchange has this shape -- which is every board this feature exists for
 * -- and reading the flag alone resolved the banner's click onto that answered
 * round while the daemon's own `waitingRounds` (roundIsAwaitedOpen) named the
 * live one. The two have to ask the same question or the click lands on the
 * wrong round on the mainline path rather than on an edge. */
function answeredThenAwaitedBoard() {
  const board = createBoard({ title: 'Stranded', blocks: [Q] });
  addRound(board, { title: 'Second', blocks: [Q] });
  const answered = board.rounds[0];
  answered.status = 'sent';
  assert.equal(answered.awaited, true,
    'setup sanity: answering does NOT clear the flag -- that is the whole trap');
  assert.equal(board.rounds[1].awaited, true, 'and round 2 is the one genuinely waiting');
  return board;
}

await check("'#stranded-round' skips a round already ANSWERED, however old -- the flag survives applySubmit, so the click has to ask what the daemon asks", () => {
  const board = answeredThenAwaitedBoard();
  const document = parseHTML(renderBoardPage(board));
  document.readyState = 'complete';
  const window = document.defaultView;
  const location = { protocol: 'http:', hash: '#stranded-round' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  const current = document.querySelector('.round-current');
  assert.ok(current, 'expected exactly one current round after the sentinel resolves');
  assert.equal(current.getAttribute('data-round'), '2',
    'round 2 is what is still waiting; round 1 was answered and only its stale awaited flag says otherwise');
});

await check("'#stranded-round' resolves to the OLDEST awaited round on load, never the newest unsent one -- the exact gap between openRoundNumber() and the banner's own contract", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  // test/dom-stand-in.mjs's StandInDocument defaults readyState to 'loading'
  // (matching a real page's inline <head> boot script, per its own comment) --
  // a real, fully-parsed page reaches 'complete' before this module script's
  // own top-level code runs, which is the immediate branch below being tested,
  // not the deferred 'load' listener (covered by its own check further down).
  document.readyState = 'complete';
  const window = document.defaultView;
  const location = { protocol: 'http:', hash: '#stranded-round' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  const current = document.querySelector('.round-current');
  assert.ok(current, 'expected exactly one current round after the sentinel resolves');
  assert.equal(current.getAttribute('data-round'), '1', "the banner's sentinel must land on round 1 (oldest still awaited), not round 2 (newest unsent but lapsed)");
});

await check("'#stranded-round' also resolves via 'hashchange' -- the commonest stranded shape is a hidden-but-connected tab, where a click is a same-document fragment change that never fires 'load' at all", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  const location = { protocol: 'http:', hash: '' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '2', 'setup: the board opens on its newest round with no sentinel present');
  location.hash = '#stranded-round';
  window.dispatchEvent(new StandInEvent('hashchange'));
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '1', "a 'hashchange' arriving on an already-open tab must resolve the sentinel exactly as 'load' does");
});

await check("'#stranded-round' also resolves via 'focus' -- revealing a tab already sitting at this exact hash from an earlier click is silent in a real browser (hash unchanged, no 'hashchange'), so a second click needs a third edge to land anywhere", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  // readyState defaults to 'complete' (test/dom-stand-in.mjs's parseHTML), so
  // running the script with the sentinel already in the hash would resolve it
  // immediately on the 'load' path -- deliberately avoided here (hash starts
  // empty, script boots, THEN the hash is set exactly as if the tab had been
  // sitting at a stale sentinel with nothing to reset it) to isolate the
  // 'focus' fallback specifically.
  const location = { protocol: 'http:', hash: '' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  location.hash = '#stranded-round';
  window.dispatchEvent(new StandInEvent('focus'));
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '1', "'focus' alone, hash already at the sentinel, must still resolve it");
});

await check("the sentinel is consumed after resolving through the location.hash='' FALLBACK (no window.history at all -- exactly what every other check here gets, and what the DOM stand-in gives by default), so an ordinary LATER refocus -- the reviewer having since navigated on their own -- can never steal them back to it", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  document.readyState = 'complete'; // see the 'on load' check above for why
  const window = document.defaultView;
  assert.equal(window.history, undefined, 'setup sanity: this check must exercise the FALLBACK branch, so window.history must be absent, not the StandInHistory the next check attaches');
  const location = { protocol: 'http:', hash: '#stranded-round' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '1', 'setup: the initial load resolved the sentinel');
  assert.notEqual(location.hash, '#stranded-round', 'the hash must be consumed (cleared) once read, or a later ordinary refocus would keep re-triggering the jump');
  // The reviewer manually flips forward, of their own accord.
  document.querySelector('.round-page[data-round="2"]').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '2', 'setup: a manual flip must move the current round');
  window.dispatchEvent(new StandInEvent('focus'));
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '2', 'an ordinary refocus, with the sentinel already consumed, must never snap the reviewer back to the old target -- that would be exactly the unbidden focus steal this product rejects everywhere else');
});

await check("the sentinel is consumed through window.history.replaceState in a REAL browser (every real browser has window.history, so this -- not the fallback above -- is the branch that actually ships): the replaced URL keeps its path and search and loses only the fragment, and a second click reusing the same literal hash is still detected afterwards", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  document.readyState = 'complete';
  const window = document.defaultView;
  const location = { protocol: 'http:', pathname: `/b/${board.id}`, search: '', hash: '#stranded-round' };
  window.history = new StandInHistory(location);
  new Function('document', 'window', 'location', ui)(document, window, location);
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '1', 'setup: the initial load resolved the sentinel');
  assert.equal(window.history.replaceStateCalls.length, 1, 'the history.replaceState branch must be the one that ran -- window.history is present, so the location.hash="" fallback must NOT have been taken instead');
  assert.deepEqual(window.history.replaceStateCalls[0], { state: null, title: '', url: `/b/${board.id}` },
    'the replaced URL must keep the pathname and search and carry no fragment at all -- dropping the fragment is what a real browser reads as "the hash is now empty"');
  assert.equal(location.hash, '', "the real side effect: replaceState with a fragment-less URL must actually clear location.hash, or a browser's OWN later reads of it (a real refocus, DevTools, anything) would still see the stale sentinel");
  // A genuine follow-up click: the daemon reuses the literal same hash value
  // for every banner, so this is indistinguishable from the first one except
  // that the hash was just cleared -- exactly the case defect 3 named.
  location.hash = '#stranded-round';
  window.dispatchEvent(new StandInEvent('hashchange'));
  assert.equal(window.history.replaceStateCalls.length, 2, 'a second click reusing the same literal hash must be consumed again, proving the first consumption did not "use up" the sentinel some other way that would leave a later genuine click stranded');
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '1', 'and must resolve the jump again too, not just record a second replaceState call');
});

await check("'#open-round' (src/indexpage.mjs's own sentinel, unrelated to the banner) keeps its existing meaning -- the LATEST unsent round -- untouched by the new one", () => {
  const board = oldestAwaitedNotNewestBoard();
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  const location = { protocol: 'http:', hash: '#open-round' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  assert.equal(document.querySelector('.round-current').getAttribute('data-round'), '2', "'#open-round' must still resolve to round 2 (the latest unsent round), exactly as it did before the banner's own sentinel existed");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall attended-client checks ok');
