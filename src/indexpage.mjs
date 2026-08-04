// The daemon root: a thread index plus archive search, as a view over the store.
// See PROTOCOL.md "HTTP surface", DESIGN.md Decisions -> "A thread per session,
// addressable from an index" and "Archived boards are searchable".
//
// A thread is `board.thread` (one MCP shim process, one Claude session). In the
// common case a thread has exactly one board doc that accumulates rounds in place
// (see PROTOCOL.md "A board is a session-scoped thread with rounds"); grouping by
// `thread` rather than assuming a 1:1 board:thread mapping keeps this correct even
// in the edge case where a caller reuses a thread id across board docs. Two threads
// with the same `cwd` are still two separate rows here, each with its own pending
// count — the exact case DESIGN.md's Decisions section calls out as the failure
// of keying by project directory instead.

import path from 'node:path';
import { styles, faviconLink } from './styles.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';
import { questionBlocks } from './board.mjs';
// formatCountdown only -- src/pomodoro.mjs's document shape, HTTP surface and
// clock are owned by other tickets and stay untouched here (ticket 04 consumes
// the API, it does not extend it). Reused rather than reimplemented in
// indexScript below, via the same Function.prototype.toString() embedding
// src/ui.mjs already uses for computeBoardPatch/composeHint/badgeLabel (see
// that file's own comment) -- one mm:ss formatter, not two that can drift.
import { formatCountdown } from './pomodoro.mjs';
import { pomodoroWidget } from './pomodoro-widget.mjs';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

/** The folder name a `cwd` shows as in the index: the last path segment only,
 * never the full path (that stays available on `title` hover). `null` when
 * the board has no project directory at all. */
export function folderName(cwd) {
  if (!cwd) return null;
  return path.basename(cwd) || cwd;
}

/** A question block is pending while the reviewer still owes it something:
 * **missing** (never submitted) or **`deferred`** (they explicitly said "revisit
 * later"). `answered` and `unanswered` are both finished states.
 *
 * `unanswered` used to count here, on the reasoning that a blank is still open
 * work. It is not, and counting it produced a badge the reviewer could not clear
 * by any legitimate action: leaving an optional catch-all ("anything else?")
 * blank IS the answer to it, so the row sat at a permanent non-zero count for the
 * whole life of the thread. Reported from real use — a fully-submitted 4-round
 * board reading `5 pending`, which was 3 `unanswered` plus 2 `deferred`.
 * PROTOCOL.md ("`status` is the only thing that says whether a question was
 * decided") backs the split: `unanswered` is an explicit signal the reviewer sent,
 * not an absence of one. `deferred` is the only status that means "come back".
 *
 * Known limitation, deliberately not papered over: a `deferred` question resolved
 * in a LATER round — or outside the board entirely — still counts here, because
 * nothing in the protocol can mark one settled. The count is honest about the
 * board's own record rather than guessing at intent. */
/** A board's `updatedAt` as a sortable string, with anything non-string treated as
 * absent (i.e. oldest) rather than stringified. `String(undefined)` is "undefined",
 * which sorts above every ISO timestamp. */
const stamp = b => (typeof b?.updatedAt === 'string' ? b.updatedAt : '');

function pendingCount(board) {
  const answers = board.answers || {};
  // questionBlocks, not a top-level walk of board.blocks (audit). Questions nest
  // inside a compare side, another question's `context`, and an option's block; the
  // top-level-only version reported "0 pending" for a board whose only question was
  // nested and explicitly deferred -- the reviewer's own recall surface saying
  // nothing was owed on a thread that was waiting on them. Every other traversal
  // (findBlock, countersFromBoard, the packet, the patch) already recurses.
  return questionBlocks(board).filter(b => {
    const a = answers[b.id];
    if (!a) return true;                    // never submitted
    return a.status === 'deferred';         // explicitly "revisit later"
  }).length;
}

/** A board is "live and waiting" while it has a posted round nobody has sent yet —
 * the same signal `POST /api/board/:id/submit` clears. */
function isLiveBoard(board) {
  return (board.rounds || []).some(r => r.status === 'open');
}

/** How many rounds one board doc has reached. */
export function roundCount(board) {
  return (board.rounds || []).length;
}

/** Group every board in the store by `board.thread` into one index row per thread.
 * Each session's board(s) stay isolated from every other session's, including one
 * with the exact same `cwd` — no cross-thread aggregation of pending counts or
 * "which board is live" happens across threads, only within one. */
export function buildThreadIndex(boards) {
  const byThread = new Map();
  for (const board of boards) {
    if (!byThread.has(board.thread)) byThread.set(board.thread, []);
    byThread.get(board.thread).push(board);
  }

  const threads = [];
  for (const [thread, group] of byThread) {
    // `stamp` rather than String(...) throughout (audit): a board whose `updatedAt`
    // is missing stringified to "undefined", which collates ABOVE every ISO date --
    // it sorted first, hijacked `primary`, and seeded the reduce below with a value
    // no real timestamp could ever beat, freezing the whole thread's date. Absent
    // now collates last, as oldest. Only reachable from a hand-edited or
    // foreign-version store file; createBoard always sets the field.
    group.sort((a, b) => stamp(b).localeCompare(stamp(a)));
    const liveBoards = group.filter(isLiveBoard);
    const primary = liveBoards[0] || group[0];
    const pending = group.reduce((sum, b) => sum + pendingCount(b), 0);
    const cwd = (group.find(b => b.cwd) || {}).cwd || null;
    const updatedAt = group.reduce((max, b) => (stamp(b) > max ? stamp(b) : max), '');
    // NOT summed across the group, unlike `pending` above: the row links to
    // `primary.id`, one specific board doc, so its round count has to describe
    // THAT board, or it contradicts the page the row opens. A two-board thread
    // (2 rounds each) summed to "4" and linked to a board whose own header read
    // "round 1 of 2" -- 4 is a round number that exists on neither board.
    // src/badge.mjs's doc comment records the board-page twin of this same bug
    // ("round ${rounds.length}" read as a position when it was only ever a
    // total); this was that mistake shipping again, on the index.
    const rounds = roundCount(primary);
    threads.push({
      thread,
      boardId: primary.id,
      cwd,
      title: primary.title || '',
      pending,
      live: liveBoards.length > 0,
      updatedAt,
      boardCount: group.length,
      rounds,
    });
  }

  threads.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return stamp(b).localeCompare(stamp(a));
  });
  return threads;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return iso;
  }
}

/** The row's headline is the board title; a title-less board falls back to the
 * project's folder name, and a board with neither falls back to a plain label —
 * never the literal word this codebase used to headline ("untitled"), since that
 * would now read as if it WERE the title. The full `cwd` moves to a `title`
 * attribute wherever it is the only thing standing in for a name. */
function threadRow(t) {
  const liveCls = t.live ? ' live' : '';
  const pendingCls = t.pending > 0 ? 'pending-badge has-pending' : 'pending-badge zero';
  const folder = folderName(t.cwd);
  const headline = t.title || folder || '(untitled)';
  const headlineIsFolder = !t.title && !!folder;
  const liveDot = t.live ? '<span class="live-dot" aria-hidden="true"></span> ' : '';
  const pathLine = headlineIsFolder
    ? ''
    : `<div class="thread-path"${folder ? ` title="${escAttr(t.cwd)}"` : ''}>${escHtml(folder || '(no project directory)')}</div>`;
  const updatedIso = escAttr(t.updatedAt);
  // escAttr, not escHtml: this value lands in BOTH the `title` attribute and the
  // element's text content below, and escHtml alone does not escape `"` -- a
  // board whose updatedAt fails to parse (formatDate then returns it verbatim)
  // would otherwise close the attribute early. escAttr is safe in text content
  // too (an extra &quot; still decodes to a literal quote).
  const updatedAbs = escAttr(formatDate(t.updatedAt));
  // A count, not an ordinal: "round N" reads as a position (which round you're
  // ON), and `rounds` here is a total, not a position -- the exact confusion
  // src/badge.mjs's own doc comment names as a real bug rather than a wording
  // nitpick. Suppressed entirely at zero (a board-shaped object with no rounds
  // at all) rather than reading "0 rounds", which nothing on a live board ever
  // is: `rounds` is always >= 1 once a board exists.
  const roundsText = t.rounds > 0 ? `${t.rounds} round${t.rounds === 1 ? '' : 's'} · ` : '';
  // Two threads can headline identically -- the same title, or both title-less
  // with the same folder, the ordinary shape for a repo run without ever setting
  // a title -- and in the title-less case `pathLine` above is also suppressed,
  // leaving nothing else on the row to vary. The thread id is always emitted
  // here for exactly that: a discriminator that survives however the headline
  // and path happen to collide, matching how the search-results row (below)
  // already carries it.
  // A live row opens the board AT the round that still needs an answer, not at
  // round 1: a thread several rounds deep otherwise lands the reviewer on
  // history they already sent and makes them scroll past it to reach the
  // question. `#open-round` is a sentinel the board page resolves in JS
  // (src/ui.mjs) through the same jumpToOpenRound the round badge uses -- NOT a
  // per-round element id, which board content can mint itself: a markdown block
  // is snapshotted from an arbitrary file and its headings slugify into ids on
  // the same page (src/markdown.mjs, test/check-archive-ids.mjs), so a heading
  // reading "Round 3" would hijack a native `#round-3` jump. A settled row keeps
  // the bare href: with nothing open there is nowhere to jump to, and a hash
  // that resolves to nothing is worse than no hash.
  const href = `/b/${escAttr(t.boardId)}${t.live ? '#open-round' : ''}`;
  return `
<a class="thread-item${liveCls}" href="${href}" data-thread-id="${escAttr(t.thread)}" data-pending="${t.pending}" data-live="${t.live}">
  <div class="thread-main">
    <div class="thread-title"${headlineIsFolder ? ` title="${escAttr(t.cwd)}"` : ''}>${liveDot}${escHtml(headline)}</div>
    ${pathLine}
    <div class="thread-meta">${roundsText}updated <time class="rel-time" datetime="${updatedIso}" title="${updatedAbs}">${updatedAbs}</time> · ${escHtml(t.thread)}</div>
  </div>
  <div class="thread-status">
    <span class="${pendingCls}">${t.pending} pending</span>
  </div>
</a>`;
}

function resultRow(r) {
  return `
<div class="result-item" data-board-id="${escAttr(r.boardId)}" data-kind="${escAttr(r.kind)}">
  <div class="result-kind">${escHtml(r.kind)}</div>
  <div class="result-text">${escHtml(r.text)}</div>
  <div class="result-meta">
    <a href="/b/${escAttr(r.boardId)}">${escHtml(r.cwd || '(no project directory)')} · ${escHtml(r.thread)}</a>
    · ${escHtml(formatDate(r.at))}
  </div>
</div>`;
}

/** The index page's only client script: keeps each row's `updated` timestamp
 * reading as relative time ("an hour ago") instead of a one-shot server-rendered
 * string that goes stale in a tab left open — the exact ISO value stays on the
 * element's `title` attribute (set server-side above) for when it is genuinely
 * needed. Small, dependency-free, inline (QUIRKS.md "No external assets, ever"),
 * and wired entirely from this script rather than from `onclick` attributes: the
 * index page carries no CSP `<meta>` today (the board page does), and that is not
 * a license to wire any differently than a page that does.
 *
 * Exported (like src/ui.mjs's `ui`), not just embedded, so test/check-pure.mjs can
 * run it through `new Function(...)` — the only thing that proves the *client
 * script itself* parses, as opposed to `node --check` on this file, which only
 * proves the outer template literal is well-formed (QUIRKS.md, same trap as
 * src/ui.mjs and src/render.mjs's stageAgentScript). Plain top-level `function`
 * declarations, no wrapping IIFE: renderIndexPage below inlines this into a
 * `<script type="module">`, whose own module scope already keeps `relTime` /
 * `refresh` off `window` without needing one — and leaving them un-wrapped is what
 * lets a check extract `relTime` by name via `new Function(indexScript + '; return
 * relTime;')()` to pin its boundaries directly, the same technique
 * `extractUiFunction` already uses on `ui`.
 *
 * `relTime` takes `now` as an explicit second argument (falling back to
 * `Date.now()`) rather than reading the clock itself, so that technique can pin
 * fixed-timestamp behaviour deterministically instead of racing the wall clock.
 *
 * This is its own top-level template literal, not inlined into renderIndexPage's
 * returned markup, for the same reason src/ui.mjs is its own export: a stray
 * literal backtick anywhere in here would terminate the OUTER string early and
 * turn the rest of this file into a syntax error (QUIRKS.md). No backticks and
 * no `${...}` below — plain string concatenation only. */
export const indexScript = `
var SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

function relTime(iso, now) {
  if (iso == null) return iso;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return iso;
  var current = (typeof now === 'number') ? now : Date.now();
  var diff = current - then;
  if (diff < 0) diff = 0;
  // Each unit is rounded FIRST, and the rounded value is what gets thresholded --
  // moment.js's own algorithm, not the obvious-looking "threshold the raw diff,
  // round only for display" this used to do. That shape had a real bug: a value
  // that rounds UP to the next tier's boundary still printed in the tier below it
  // for one more tick -- 44m59s read '45 minutes ago', and one second later,
  // 45m00s, read 'an hour ago'. Rounding first removes the state entirely: both
  // now read 'an hour ago', since 44m59s already rounds to 45 minutes, which is
  // no longer < 45. It also reproduces the original singular-vs-plural cutoffs
  // (90s, 90min, 36h, 45d, ~18mo) without spelling any of them out as their own
  // constants: a diff that rounds to 1 in the unit above takes the singular
  // ("a minute ago"), never the plural, because Math.round(1.5) is 2.
  var minutes = Math.round(diff / MIN);
  var hours = Math.round(diff / HOUR);
  var days = Math.round(diff / DAY);
  var months = Math.round(diff / (30 * DAY));
  var years = Math.round(diff / (365 * DAY));
  if (diff < 45 * SEC) return 'just now';
  if (minutes <= 1) return 'a minute ago';
  if (minutes < 45) return minutes + ' minutes ago';
  if (hours <= 1) return 'an hour ago';
  if (hours < 22) return hours + ' hours ago';
  if (days <= 1) return 'a day ago';
  if (days < 25) return days + ' days ago';
  if (months <= 1) return 'a month ago';
  if (months < 12) return months + ' months ago';
  if (years <= 1) return 'a year ago';
  return years + ' years ago';
}

function refresh() {
  var els = document.querySelectorAll('.rel-time');
  for (var i = 0; i < els.length; i++) {
    var iso = els[i].getAttribute('datetime');
    if (iso) els[i].textContent = relTime(iso);
  }
}

refresh();
// 15s, not 60s: the narrowest bucket above ("a minute ago", 45s to 90s) is only
// 45 seconds wide. A row can load at any offset within a bucket, so a 60s poll
// can step clean over one depending on where load time happens to land -- a row
// loaded at age 44s reads "just now" until its true age is 1m44s, skipping "a
// minute ago" for that row entirely. 15s comfortably undersamples every bucket
// here, including the narrowest one.
setInterval(refresh, 15000);
` + '\n' + formatCountdown.toString() + '\n' + `
// =================================================================================
// The pomodoro widget (ticket 04, SPEC_POMODORO.md). Everything below this line
// is appended by '+' concatenation, never dollar-brace interpolation, exactly like
// the formatCountdown embedding just above -- this file's own header comment
// bans a literal backtick or interpolation ANYWHERE inside the indexScript
// template literal itself (a stray one would terminate the string early and
// turn the rest of this file into a syntax error, QUIRKS.md). formatCountdown's
// OWN source (spliced in above) happens to contain real template-literal
// syntax -- that is safe here because splicing happens at MODULE LOAD time, as
// a plain string value, never as literal text typed inside this backtick
// block; see this export's header comment for the fuller version of the same
// reasoning src/ui.mjs's own dollar-brace fn.toString() embeddings rely on.
//
// Design, matching SPEC_POMODORO.md's own decisions:
//  - The page owns no clock. Every rendered countdown comes from
//    'pomodoroRemainingMs(timer, offset, Date.now())' below, where 'offset' is
//    computed ONCE PER FETCH from the DAEMON's own 'now' (never the bare
//    browser clock) -- see fetchPomodoro's comment. Two tabs polling the same
//    daemon each compute their own offset from the same server clock, which is
//    what makes their rendered countdowns agree regardless of either browser's
//    own clock skew (criterion 6).
//  - Nothing here ever decides a work interval became a break or a break
//    became work -- that is settleBoundary's job (src/pomodoro.mjs), and it
//    runs on the daemon, never in this script. tickPomodoro below only asks
//    the daemon what happened, once, when the local countdown reaches zero.
//  - 'timer: null' (no pomodoro running) is a real, calm state, not an error
//    and not a reason to offer a Start button here -- starting one is a
//    session-start signal owned by another slice (criterion 1). This widget
//    only ever offers Pause/Resume/Reset against a timer that already exists.

var POMODORO_POLL_MS = 15000; // same order of magnitude as refresh's own poll above
var pomodoroDoc = null; // last-fetched { settings, cycle, cycleDate, timer, now }
var pomodoroOffset = 0; // serverNow - Date.now(), recomputed on every successful fetch
var pomodoroZeroFetched = false; // debounces the zero-crossing re-fetch below
var pomodoroResetArmed = false;
var pomodoroResetTimer = null;

// Pure: given a timer snapshot from the daemon, the clock offset computed at
// the last successful fetch, and the browser's current clock, returns the
// remaining ms. Deliberately never reads doc.now or Date.now() a second time
// on its own -- every caller passes browserNow explicitly, which is what lets
// a check pin this against a fixed clock instead of racing the wall clock
// (same shape as indexScript's own relTime(iso, now) above). A paused timer
// ignores offset/browserNow entirely: pauseTimer (src/pomodoro.mjs) already
// froze remainingMs server-side, and there is no live deadline left to
// subtract anything from.
function pomodoroRemainingMs(timer, offset, browserNow) {
  if (!timer) return 0;
  if (timer.paused) return Math.max(0, timer.remainingMs || 0);
  return Math.max(0, timer.deadline - (browserNow + offset));
}

function pomodoroPhaseLabel(phase) {
  if (phase === 'work') return 'Work';
  if (phase === 'longBreak') return 'Long break';
  return 'Break';
}

// Render only -- never decides anything. No branch here mutates
// pomodoroDoc.timer or invents a next phase: an expired countdown just prints
// 00:00 (formatCountdown's own clamp) until the next fetchPomodoro() call
// replaces pomodoroDoc with whatever the daemon actually settled on.
function renderPomodoro() {
  var statusEl = document.querySelector('span#pomodoro-status');
  var toggleBtn = document.querySelector('button#pomodoro-toggle');
  if (!pomodoroDoc) return;
  var timer = pomodoroDoc.timer;
  if (!timer) {
    // No timer running is a real state, not an error: show the configured
    // work length as a calm, honest default, never a countdown and never a
    // Start affordance (see this section's header comment).
    if (statusEl) statusEl.textContent = 'Pomodoro: idle (' + pomodoroDoc.settings.workMin + ' min)';
    if (toggleBtn) toggleBtn.hidden = true;
  } else {
    var ms = pomodoroRemainingMs(timer, pomodoroOffset, Date.now());
    var text = 'Pomodoro: ' + pomodoroPhaseLabel(timer.phase) + ' ' + formatCountdown(ms);
    if (timer.paused) text += ' (paused)';
    if (statusEl) statusEl.textContent = text;
    if (toggleBtn) {
      toggleBtn.hidden = false;
      toggleBtn.textContent = timer.paused ? 'Resume' : 'Pause';
    }
  }
  pomodoroSyncForm();
}

// Keeps the (collapsed-by-default) settings panel showing the daemon's actual
// values, not just whatever was there at page load -- a reader who opens it
// after another tab changed a duration should see the current numbers. Skips
// whichever field is currently focused, so a background poll landing mid-edit
// never yanks the cursor or overwrites an in-progress keystroke.
function pomodoroSyncForm() {
  var form = document.querySelector('form#pomodoro-settings-form');
  if (!form || !pomodoroDoc) return;
  var s = pomodoroDoc.settings;
  var active = document.activeElement;
  // form.querySelector('input[name="..."]'), never the bare named-form-control
  // shorthand ('form.workMin') a real browser also supports -- this repo's own
  // comment forms (src/ui.mjs) already look fields up this same explicit way,
  // and it is what test/dom-stand-in.mjs's selector engine actually implements.
  var workMin = form.querySelector('input[name="workMin"]');
  var breakMin = form.querySelector('input[name="breakMin"]');
  var longBreakMin = form.querySelector('input[name="longBreakMin"]');
  var longEvery = form.querySelector('input[name="longEvery"]');
  var notify = form.querySelector('input[name="notify"]');
  var sound = form.querySelector('input[name="sound"]');
  if (workMin && active !== workMin) workMin.value = s.workMin;
  if (breakMin && active !== breakMin) breakMin.value = s.breakMin;
  if (longBreakMin && active !== longBreakMin) longBreakMin.value = s.longBreakMin;
  if (longEvery && active !== longEvery) longEvery.value = s.longEvery;
  if (notify && active !== notify) notify.checked = !!s.notify;
  if (sound && active !== sound) sound.checked = !!s.sound;
}

// fetch/credentials: 'same-origin', matching src/ui.mjs's own submitBoard --
// the session cookie a browser holds after /auth/:token is what authorises
// GET /api/pomodoro and the pause/resume/reset/settings writes
// (POMODORO_COOKIE_ACTIONS, src/server.mjs); this widget carries no secret of
// its own and needs none.
function fetchPomodoro() {
  return fetch('/api/pomodoro', { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('pomodoro fetch failed: ' + r.status);
    return r.json();
  }).then(function (data) {
    // Recomputed on every successful read, not just once at page load: the
    // daemon's own 'now' (src/server.mjs sendPomodoro) is what makes this
    // correct regardless of how far the browser's wall clock has drifted --
    // never 'deadline - Date.now()' directly. See this section's header
    // comment for why that is what makes two tabs agree (criterion 6).
    pomodoroOffset = data.now - Date.now();
    pomodoroDoc = data;
    pomodoroZeroFetched = false;
    renderPomodoro();
  });
}

function postPomodoro(action, body) {
  return fetch('/api/pomodoro/' + action, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) {
    if (!r.ok) throw new Error('pomodoro ' + action + ' failed: ' + r.status);
    return r.json();
  }).then(function (data) {
    pomodoroOffset = data.now - Date.now();
    pomodoroDoc = data;
    renderPomodoro();
    return data;
  });
}

// The one place a boundary crossing is noticed client-side, and all it does is
// ask the daemon what actually happened -- never advance pomodoroDoc.timer
// itself (settleBoundary, src/pomodoro.mjs, is the only code that ever decides
// a phase changed, and it runs on the daemon). ponytail: fetches once per
// zero-crossing (pomodoroZeroFetched guards the repeat) rather than retrying
// every tick while offline -- the POMODORO_POLL_MS interval below is the
// backstop if that one fetch is lost to a network hiccup.
function tickPomodoro() {
  if (!pomodoroDoc) return;
  renderPomodoro();
  var timer = pomodoroDoc.timer;
  if (!timer || timer.paused) return;
  var ms = pomodoroRemainingMs(timer, pomodoroOffset, Date.now());
  if (ms <= 0 && !pomodoroZeroFetched) {
    pomodoroZeroFetched = true;
    fetchPomodoro();
  }
}

function onPomodoroToggleClick() {
  if (!pomodoroDoc || !pomodoroDoc.timer) return; // no timer: the button is hidden, never reachable
  postPomodoro(pomodoroDoc.timer.paused ? 'resume' : 'pause');
}

function pomodoroDisarmReset(btn) {
  pomodoroResetArmed = false;
  if (pomodoroResetTimer) { clearTimeout(pomodoroResetTimer); pomodoroResetTimer = null; }
  if (btn) { btn.textContent = 'Reset'; btn.classList.remove('armed'); }
}

// Two-step confirm, not confirm() -- see pomodoro-widget.mjs's own comment on
// the reset button for why a blocking modal was rejected. First click arms
// it (relabels, adds .armed, starts a revert timer); a second real click
// inside that window is what actually posts the reset. setTimeout here is
// the one timer in this file NOT routed through indexScript's injected
// 'setInterval' param (that seam exists for the refresh/tick/poll intervals a
// check wants to drive by hand) -- unref'd, matching src/pomodoro.mjs's own
// timeoutHandle.unref() comment, so a lingering armed-reset window is never
// the reason an in-process check's node process fails to exit on its own.
function onPomodoroResetClick() {
  var btn = document.querySelector('button#pomodoro-reset');
  if (!pomodoroResetArmed) {
    pomodoroResetArmed = true;
    if (btn) { btn.textContent = 'Really reset?'; btn.classList.add('armed'); }
    pomodoroResetTimer = setTimeout(function () { pomodoroDisarmReset(btn); }, 4000);
    if (pomodoroResetTimer && typeof pomodoroResetTimer.unref === 'function') pomodoroResetTimer.unref();
    return;
  }
  pomodoroDisarmReset(btn);
  postPomodoro('reset');
}

function onPomodoroSettingsSubmit(ev) {
  ev.preventDefault();
  var form = ev.target;
  postPomodoro('settings', {
    workMin: parseInt(form.querySelector('input[name="workMin"]').value, 10),
    breakMin: parseInt(form.querySelector('input[name="breakMin"]').value, 10),
    longBreakMin: parseInt(form.querySelector('input[name="longBreakMin"]').value, 10),
    longEvery: parseInt(form.querySelector('input[name="longEvery"]').value, 10),
    notify: !!form.querySelector('input[name="notify"]').checked,
    sound: !!form.querySelector('input[name="sound"]').checked,
  });
}

function initPomodoroWidget() {
  var widget = document.querySelector('div#pomodoro-widget');
  if (!widget) return;
  var toggleBtn = document.querySelector('button#pomodoro-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', onPomodoroToggleClick);
  var resetBtn = document.querySelector('button#pomodoro-reset');
  if (resetBtn) resetBtn.addEventListener('click', onPomodoroResetClick);
  var form = document.querySelector('form#pomodoro-settings-form');
  if (form) form.addEventListener('submit', onPomodoroSettingsSubmit);
  fetchPomodoro();
  // Local repaint (no fetch): recomputes the countdown text from the already-
  // cached doc + offset every second, so the widget visibly ticks between
  // polls. Also the trigger for the single zero-crossing re-fetch above --
  // never a phase decision of its own.
  setInterval(tickPomodoro, 1000);
  // Modest re-fetch interval (same order of magnitude as refresh's 15s poll
  // above) to notice a boundary the daemon crossed even if the zero-crossing
  // fetch above was lost -- see tickPomodoro's own comment.
  setInterval(fetchPomodoro, POMODORO_POLL_MS);
}
initPomodoroWidget();
`;

/** Render the complete index page: the thread list (with pending counts, round
 * counts and a visual live/settled distinction) plus, when `query` is non-empty,
 * the archive search results inline — a plain GET-form round trip needing no
 * client JS of its own. The page's one script (`indexScript` above) only ever
 * touches `.rel-time` text content; nothing here depends on it running. */
export function renderIndexPage({ threads = [], query = '', results = [] } = {}) {
  const threadsHtml = threads.length
    ? threads.map(threadRow).join('\n')
    : '<p class="empty-state">No threads yet. Boards posted by a session will show up here.</p>';

  const showResults = query.trim().length > 0;
  const resultsHtml = !showResults
    ? ''
    : results.length
      ? `<div class="result-list">${results.map(resultRow).join('\n')}</div>`
      : '<p class="empty-state">No matches.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-board</title>
${faviconLink}
<script>${themeBootScript}</script>
<style>${styles}</style>
</head>
<body>
<div class="index-shell">
  <header class="index-head">
    <div class="index-head-titles">
      <h1>claude-board</h1>
      <div class="meta">one thread per Claude session</div>
    </div>
    <div class="index-head-actions">
      ${pomodoroWidget()}
      ${themeToggle()}
    </div>
  </header>

  <form class="search-form" action="/" method="get">
    <input class="search-input" type="text" name="q" placeholder="Search archived boards — what was asked, what was answered…" value="${escAttr(query)}">
    <button class="search-btn" type="submit">Search</button>
  </form>
  ${showResults ? `<section class="search-results" data-query="${escAttr(query)}">${resultsHtml}</section>` : ''}

  <div class="thread-list">
    ${threadsHtml}
  </div>
</div>
<script type="module">${indexScript}</script>
</body>
</html>
`;
}
