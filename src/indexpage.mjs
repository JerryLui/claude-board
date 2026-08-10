// The daemon root: a thread index plus archive search, as a view over the store.
// See PROTOCOL.md "HTTP surface" for the routes, and DESIGN.md Decisions -> "A thread per
// session, addressable from an index" and "Archived boards are searchable" for the why.
//
// A thread is `board.thread` (one MCP shim process, one Claude session). In the
// common case a thread has exactly one board doc that accumulates rounds in place
// (see DESIGN.md Decisions -> "A board is a session-scoped thread with rounds"); grouping by
// `thread` rather than assuming a 1:1 board:thread mapping keeps this correct even
// in the edge case where a caller reuses a thread id across board docs. Two threads
// with the same `cwd` are still two separate rows here, each with its own rounds-left
// count — the exact failure
// of keying by project directory instead.

import path from 'node:path';
import { styles, faviconLink, restFaviconHref, markSvg } from './styles.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';
import { roundIsAwaited } from './badge.mjs';
// formatCountdown only -- src/pomodoro.mjs's document shape, HTTP surface and
// clock are owned by other tickets and stay untouched here (this file consumes
// the API, it does not extend it). Reused rather than reimplemented in
// indexScript below, via the same Function.prototype.toString() embedding
// src/ui.mjs already uses for computeBoardPatch/composeHint/roundNumberLabel
// (see that file's own comment) -- one mm:ss formatter, not two that can drift.
import { formatCountdown } from './pomodoro.mjs';
import { pomodoroWidget, TOMATO_ICON, REST_ICON } from './pomodoro-widget.mjs';

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

/** A board's `updatedAt` as a sortable string, with anything non-string treated as
 * absent (i.e. oldest) rather than stringified. `String(undefined)` is "undefined",
 * which sorts above every ISO timestamp. */
const stamp = b => (typeof b?.updatedAt === 'string' ? b.updatedAt : '');

/** A board's rounds that are still open **and still awaited** — a trip back to the
 * board the reviewer genuinely owes (CONTEXT.md
 * "Awaited"/"Rounds left"). This is the one predicate both the index badge's count
 * and `isLiveBoard` below read, so the two can never disagree: a round nobody is
 * listening on has no gesture that could ever clear it (`POST
 * /api/board/:id/submit` is the only thing that marks a round `sent`, and a
 * reviewer submits by answering or, on an awaited page board, by sending
 * comments), so a skill that renders a document and posts a pointer to it —
 * `/explain`, `/visualize`, `/gamify` — without `wait` asks nothing and hears
 * nothing back by design, and must count as settled, not as a permanent false
 * alarm. A page board posted WITH `wait: true` (ADR.md entry 45) is exactly the
 * opposite of that: the call is genuinely blocked on it, so it counts too.
 *
 * `roundIsAwaited` (src/badge.mjs), not a bare `r.awaited` read: a round minted
 * before ADR.md entry 45 landed carries neither `awaited` nor `awaitDeadline` at
 * all (`undefined`, not `false`), and that helper is what falls back to the OLD
 * shape-based inference (a question block anywhere in the round, nested included
 * — a compare side, another question's `context`, an option's block) for exactly
 * those legacy rounds, so a board already on disk keeps counting toward the badge
 * and the tab mark exactly as it always did rather than silently dropping out the
 * moment this shipped. Shared with src/server.mjs's drainUndeliveredComments and
 * src/ui.mjs's markPendingRound (the tab mark and the arrival notification) —
 * one definition of "awaited", not three that could drift. */
function openAwaitedRounds(board) {
  return (board.rounds || []).filter(r => r.status === 'open' && roundIsAwaited(board, r));
}

/** A board is "live and waiting" while `openAwaitedRounds` finds at least one round —
 * derived from that same predicate, never a second test of its own, so this and the
 * index badge's count are structurally incapable of disagreeing.
 *
 * Deliberately NOT a "visited" flag. Tracking whether someone had opened the page needs
 * per-reader state the store does not have, and a GET that writes; nothing is owed here
 * regardless of whether anyone looked, so the honest signal is the question, not the
 * visit. */
function isLiveBoard(board) {
  return openAwaitedRounds(board).length > 0;
}

/** How many rounds one board doc has reached. */
export function roundCount(board) {
  return (board.rounds || []).length;
}

/** Group every board in the store by `board.thread` into one index row per thread.
 * Each session's board(s) stay isolated from every other session's, including one
 * with the exact same `cwd` — no cross-thread aggregation of rounds-left counts or
 * "which board is live" happens across threads, only within one. */
export function buildThreadIndex(boards) {
  const byThread = new Map();
  for (const board of boards) {
    if (!byThread.has(board.thread)) byThread.set(board.thread, []);
    byThread.get(board.thread).push(board);
  }

  const threads = [];
  for (const [thread, group] of byThread) {
    // `stamp` rather than String(...) throughout: a board whose `updatedAt`
    // is missing stringified to "undefined", which collates ABOVE every ISO date --
    // it sorted first, hijacked `primary`, and seeded the reduce below with a value
    // no real timestamp could ever beat, freezing the whole thread's date. Absent
    // now collates last, as oldest. Only reachable from a hand-edited or
    // foreign-version store file; createBoard always sets the field.
    group.sort((a, b) => stamp(b).localeCompare(stamp(a)));
    const liveBoards = group.filter(isLiveBoard);
    const primary = liveBoards[0] || group[0];
    // Summed across every board doc in the thread (unlike `rounds` below): a
    // reader's trip count is a fact about the whole thread, not about whichever
    // board doc the row happens to link to.
    const roundsLeft = group.reduce((sum, b) => sum + openAwaitedRounds(b).length, 0);
    const cwd = (group.find(b => b.cwd) || {}).cwd || null;
    const updatedAt = group.reduce((max, b) => (stamp(b) > max ? stamp(b) : max), '');
    // NOT summed across the group, unlike `roundsLeft` above: the row links to
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
      roundsLeft,
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
  // Absent entirely at zero, never a zero-reading badge: `roundsLeft` and
  // `live` are both derived from `openAwaitedRounds` (src/indexpage.mjs), so this
  // element and the pulsing `.live-dot` above it can never disagree about whether
  // the row owes the reader anything.
  const badge = t.roundsLeft > 0
    ? `<div class="thread-status"><span class="rounds-left-badge">${t.roundsLeft} round${t.roundsLeft === 1 ? '' : 's'} left</span></div>`
    : '';
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
  // and path happen to collide — and, since the search box became a filter over
  // these rows, the only thing on the row a reader can type to isolate one of
  // two identically-headlined sessions (filterThreads matches it).
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
<a class="thread-item${liveCls}" href="${href}" data-thread-id="${escAttr(t.thread)}" data-rounds-left="${t.roundsLeft}" data-live="${t.live}">
  <div class="thread-main">
    <div class="thread-title"${headlineIsFolder ? ` title="${escAttr(t.cwd)}"` : ''}>${liveDot}${escHtml(headline)}</div>
    ${pathLine}
    <div class="thread-meta">${roundsText}updated <time class="rel-time" datetime="${updatedIso}" title="${updatedAbs}">${updatedAbs}</time> · ${escHtml(t.thread)}</div>
  </div>
  ${badge}
</a>`;
}

/** The contents of `.thread-list`: the filtered rows, or whichever empty state
 * applies. The ONE renderer for that markup, called both by `renderIndexPage`
 * below (server-rendered first paint) and by `GET /api/index/rows` (the poll the
 * page runs on its own fifteen-second tick, ADR 77) — so what the poll patches in
 * can never drift from what the page was served with.
 *
 * Two different empty states, because they mean two different things: an empty
 * STORE is "nothing has happened yet, here is what would put something here",
 * while an empty FILTER is "your query excluded everything, the list itself is
 * fine". Reporting the first when the second is true would read as if the
 * sessions had gone missing. */
export function renderThreadRows({ threads = [], query = '' } = {}) {
  const filtering = query.trim().length > 0;
  const shown = filterThreads(threads, query);
  if (shown.length) return shown.map(threadRow).join('\n');
  return filtering
    ? `<p class="empty-state">No sessions match “${escHtml(query.trim())}”.</p>`
    : '<p class="empty-state">No threads yet. Boards posted by a session will show up here.</p>';
}

/** The index page's only client script. Two jobs on one fifteen-second tick: it
 * keeps each row's `updated` timestamp reading as relative time ("an hour ago")
 * instead of a one-shot server-rendered string that goes stale in a tab left open
 * — the exact ISO value stays on the element's `title` attribute (set server-side
 * above) for when it is genuinely needed — and it fetches the rows themselves from
 * `GET /api/index/rows` and patches the list in place, so a board posted after the
 * page loaded appears without anyone reloading (ADR 77). Small, dependency-free,
 * inline (QUIRKS.md "No external assets — except two bare sibling filenames"; an
 * icon is not one of them),
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
 * Four globals a real page always has are what this needs in scope: `document`,
 * `setInterval`, and — since the settings panel answers a URL fragment
 * (`openPomodoroSettingsFromFragment` below) — `window` and `location`, exactly
 * the pair `ui` already takes as `new Function('document', 'window', 'location',
 * ui)`. A check driving the REAL page markup has to supply all four; the
 * function-extraction stand-ins above never reach the two new ones, because
 * `initPomodoroWidget` bails on a document with no `div#pomodoro-widget` in it
 * long before either is read.
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

// The rows this tab last patched in, so an unchanged list is left completely
// alone -- no DOM write, no lost text selection, no repaint (ADR 77). Starts
// null, so the FIRST poll always patches once even against an unchanged store;
// the server-rendered markup cannot be read back to compare against (the page is
// served with it, and reading innerHTML back to fingerprint it would be a parse
// per tick for one saved write on one tick).
var lastRowsHtml = null;
// One poll at a time. A daemon answering slower than the tick would otherwise
// accumulate an outstanding request per tick, and responses can land out of
// order -- a slow tick-1 answer arriving after a fast tick-2 answer differs from
// lastRowsHtml and patches the OLDER rows in over the newer ones. It self-corrects
// on the next tick, so the cost is one interval of a stale list, but it is a
// stale list shown for no reason. Skipping is right rather than queueing: the
// next tick is fifteen seconds away and asks the same question.
var rowsInFlight = false;

// The index polls for its rows and patches the LIST, never the page (ADR 77).
// Not SSE: this is a page nobody stares at, and a live connection per open tab
// costs the daemon more than being at most one tick behind costs the reader. Not
// a reload either, and that is the load-bearing half -- replacing only the list's
// contents is what leaves the scroll position and whatever is typed in the search
// box exactly as they were, which a reload would throw away.
//
// The query comes off the list element rather than the URL: this script's only
// injected globals are 'document' and 'setInterval'.
//
// credentials: 'same-origin', like fetchPomodoro below -- the session cookie a
// browser holds after /auth/:token is what authorises this read; the page carries
// no secret of its own and needs none. Failures are swallowed: a daemon mid-restart
// or a sleeping laptop must leave the list as it is, not blank it or shout.
//
// ponytail: the whole list is re-set when anything in it changed, rather than the
// changed rows being patched one by one. Ceiling: any change repaints every row,
// so a row can never hold client-side state of its own (nothing on it does today
// -- a row is a link). Upgrade path: key the rows by data-thread-id and patch
// per row.
function patchRows() {
  var list = document.querySelector('div.thread-list');
  if (!list || rowsInFlight) return;
  var q = list.getAttribute('data-query') || '';
  rowsInFlight = true;
  return fetch('/api/index/rows?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error('index rows fetch failed: ' + r.status);
      return r.json();
    })
    .then(function (data) {
      if (!data || typeof data.html !== 'string') return;
      if (data.html === lastRowsHtml) return;
      lastRowsHtml = data.html;
      list.innerHTML = data.html;
      // The rows arrive carrying absolute stamps, exactly as the server-rendered
      // ones did; this is what turns them relative again.
      refresh();
    })
    .catch(function () { /* leave the list as it is: see this function's comment */ })
    // Cleared on BOTH paths, and after the catch rather than beside it: a failed
    // poll that left this set would stop the list updating for the life of the
    // tab, which is a worse outcome than the pile-up it guards against.
    .then(function () { rowsInFlight = false; });
}

function tick() {
  refresh();
  patchRows();
}

refresh();
// 15s, not 60s: the narrowest bucket above ("a minute ago", 45s to 90s) is only
// 45 seconds wide. A row can load at any offset within a bucket, so a 60s poll
// can step clean over one depending on where load time happens to land -- a row
// loaded at age 44s reads "just now" until its true age is 1m44s, skipping "a
// minute ago" for that row entirely. 15s comfortably undersamples every bucket
// here, including the narrowest one. The rows ride the same tick rather than
// getting one of their own: one interval, one reason for the page to wake up.
setInterval(tick, 15000);
` + '\n' + formatCountdown.toString() + '\n' + `
// =================================================================================
// The pomodoro widget. Everything below this line
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
// Design:
//  - The page owns no clock. Every rendered countdown comes from
//    'pomodoroRemainingMs(timer, offset, Date.now())' below, where 'offset' is
//    computed ONCE PER FETCH from the DAEMON's own 'now' (never the bare
//    browser clock) -- see fetchPomodoro's comment. Two tabs polling the same
//    daemon each compute their own offset from the same server clock, which is
//    what makes their rendered countdowns agree regardless of either browser's
//    own clock skew.
//  - Nothing here ever decides a work interval became a break or a break
//    became work -- that is settleBoundary's job (src/pomodoro.mjs), and it
//    runs on the daemon, never in this script. tickPomodoro below only asks
//    the daemon what happened, once, when the local countdown reaches zero.
//  - 'timer: null' (no pomodoro running) is a real, calm state, not an error.
//    The session-start hook (POST /api/pomodoro/ensure) is still the ordinary
//    way a pomodoro begins; the switch below is a SECOND door onto that same
//    route, for a reader who wants to start one by hand without waiting for the
//    next session. One control, three transitions -- idle -> ensure, running ->
//    pause, paused -> resume -- so it always has something to do and never has
//    to hide (the old hidden-button shape did not actually hide; see
//    src/pomodoro-widget.mjs's own comment for why).
//  - The tab favicon and the header glyph both read the
//    SAME running-unpaused-break predicate -- pomodoroIsResting below, defined
//    once and called from both renderPomodoroFavicon and renderPomodoroGlyph --
//    so the tab and the header can never disagree about which phase counts as
//    "resting". A null phase (pomodoroDoc still null, before the first fetch
//    resolves) is not a break: the predicate requires a real timer object, so a
//    slow first load renders the ordinary mark and glyph, never flickers
//    through rest.

var POMODORO_POLL_MS = 15000; // same order of magnitude as refresh's own poll above
var pomodoroDoc = null; // last-fetched { settings, cycle, cycleDate, timer, now }
var pomodoroOffset = 0; // serverNow - Date.now(), recomputed on every successful fetch
var pomodoroZeroFetched = false; // debounces the zero-crossing re-fetch below
var pomodoroResetArmed = false;
var pomodoroResetTimer = null;
// One pending debounce timer per cue field name --
// see onPomodoroCueChange's own comment for why a per-field map, not one
// shared timer.
var pomodoroPreviewTimers = {};
var POMODORO_PREVIEW_DEBOUNCE_MS = 150;

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

// The running interval's position in the cycle -- 'N/M', or null for a phase
// that carries none. Derived from doc.cycle exactly the way settleBoundary
// (src/pomodoro.mjs) itself advances it, never a second count kept in the
// browser: cycle counts the work intervals already completed since the last
// long break (or local midnight), incremented only when a BREAK ends, so it
// stays UNCHANGED for the short break that follows a work interval and is read
// again there. cycle + 1 is therefore the ordinal of whichever work-or-break
// interval is currently running, out of settings.longEvery -- and a long break
// itself is deliberately excluded, since the breakNumber that selected it was
// already a multiple of longEvery, and a break should never be bucketed
// against the interval count it resets. No server-side or
// protocol change needed for this: doc.cycle is already in the document the
// browser polls.
//
// Clamped at longEvery, which only matters when the reviewer LOWERS longEvery
// mid-cycle: cycle is already past the new divisor, so the bare ordinal reads
// '6/2' -- not a position in a cycle of two, and visibly wrong for the up-to-one
// interval it takes settleBoundary to reset cycle at the next long break. The
// clamp is not a guess: cycle + 1 is the breakNumber settleBoundary is about to
// test, and once it is at or past longEvery the next break IS the long one, so
// 'last interval of the cycle' is exactly what is true.
function pomodoroCyclePosition(phase, cycle, longEvery) {
  if (phase !== 'work' && phase !== 'break') return null;
  return Math.min(cycle + 1, longEvery) + '/' + longEvery;
}

// The switch is ON exactly when a timer is running unpaused. Idle and paused
// both read as off, and both turn back on -- one 'ensure', the other 'resume'.
// The label names the ACTION, which is what the control is for; the state is
// carried by aria-checked and the knob.
function pomodoroSwitchAction(timer) {
  if (!timer) return 'ensure';
  return timer.paused ? 'resume' : 'pause';
}

function pomodoroSwitchLabel(action) {
  if (action === 'ensure') return 'Start pomodoro';
  if (action === 'resume') return 'Resume pomodoro';
  return 'Pause pomodoro';
}
` + '\n' +
'var REST_FAVICON_HREF = ' + JSON.stringify(restFaviconHref) + ';\n' +
'var TOMATO_ICON = ' + JSON.stringify(TOMATO_ICON) + ';\n' +
'var REST_ICON = ' + JSON.stringify(REST_ICON) + ';\n'
+ `
// Real values spliced in from src/pomodoro-widget.mjs
// and src/styles.mjs (JSON.stringify, the same "embed the real source, never a
// hand copy" discipline formatCountdown.toString() already uses just above) --
// TOMATO_ICON/REST_ICON/REST_FAVICON_HREF above are literally
// src/pomodoro-widget.mjs's and src/styles.mjs's own exports, not a second
// drawing that could drift from either.

// The one predicate both the tab mark and the header glyph read: true only for a REAL timer, RUNNING (not paused), on a break or long
// break. Idle, paused -- in ANY phase, including mid-break -- and work all read
// false, and so does a timer pomodoroDoc has not been fetched yet (timer is
// null/undefined then, same as genuinely idle): "no poll has returned" and
// "idle" are indistinguishable on purpose, since a phase this is at most one
// poll interval stale about is not evidence of a break ("a null
// phase means no mark change, never on break"). Exported to neither the tab nor
// the glyph individually -- both call this SAME function, so they cannot render
// two different opinions about which phase counts as "resting".
function pomodoroIsResting(timer) {
  return !!timer && !timer.paused && (timer.phase === 'break' || timer.phase === 'longBreak');
}

// The glyph's amber condition -- deliberately a SEPARATE
// predicate from pomodoroIsResting rather than its negation: idle and paused
// both fail this AND fail pomodoroIsResting, and still have to render the
// plain muted tomato, not amber -- "idle has nothing to turn up for"
// is exactly the asymmetry a bare negation of pomodoroIsResting
// would erase.
function pomodoroIsActiveWork(timer) {
  return !!timer && !timer.paused && timer.phase === 'work';
}

// The index tab's own favicon swap. Same base-href capture/restore SHAPE as src/ui.mjs's
// setFaviconBadge -- captured lazily on first call, from whatever the page's
// own <link rel="icon"> (faviconLink, src/styles.mjs) already carries, and
// restored exactly rather than hardcoded, so this still does the right thing
// if the link's initial href is ever something other than the plain mark.
// Deliberately NOT a shared module with setFaviconBadge (this section's own
// header comment) -- the two pages have nothing else in common to justify one.
var pomodoroFaviconLink = null;
var pomodoroBaseFaviconHref = null;
function renderPomodoroFavicon(timer) {
  if (!pomodoroFaviconLink) {
    pomodoroFaviconLink = document.querySelector('link[rel="icon"]');
    if (pomodoroFaviconLink) pomodoroBaseFaviconHref = pomodoroFaviconLink.getAttribute('href');
  }
  if (!pomodoroFaviconLink) return; // faviconLink is always server-rendered; nothing to degrade to if it is somehow absent
  // A pending count wins outright: the index page owns no
  // pending-count favicon state of its own -- that is src/ui.mjs's
  // setFaviconBadge, reachable only from a BOARD tab ("the
  // rest mark is index-only"), so there is nothing on THIS page that could ever
  // need to outrank the rest mark. The precedence still belongs here, not only
  // in this comment: pomodoroIsResting is the ONLY thing that may pick
  // REST_FAVICON_HREF, so nothing else this script does -- now or if a pending
  // signal is ever added to this page later -- can set it by accident.
  pomodoroFaviconLink.setAttribute('href', pomodoroIsResting(timer) ? REST_FAVICON_HREF : pomodoroBaseFaviconHref);
}

// The header glyph swap. Swaps the glyph's MARKUP, never the
// 'hidden' property -- .pomodoro-icon carries an author 'display' rule that
// the UA stylesheet's '[hidden] { display: none }' can never outrank (this
// section's own header comment: the exact trap that once left a dead pill
// stuck in the header). pomodoroIconKind remembers which glyph is currently
// mounted so the 1s local-repaint tick (tickPomodoro, which calls renderPomodoro
// every second regardless of whether anything changed) does not re-parse the
// same SVG string every second -- the swap itself is still instant either way
// (nothing here animates or transitions), this only skips
// redundant DOM writes.
var pomodoroIconKind = null; // 'tomato' | 'rest', null before the first render
function renderPomodoroGlyph(timer) {
  var slot = document.querySelector('span#pomodoro-icon-slot');
  var statusEl = document.querySelector('span#pomodoro-status');
  var resting = pomodoroIsResting(timer);
  var kind = resting ? 'rest' : 'tomato';
  if (slot && kind !== pomodoroIconKind) {
    slot.innerHTML = resting ? REST_ICON : TOMATO_ICON;
    pomodoroIconKind = kind;
  }
  // The colour swap is independent of which glyph is mounted: work is the only
  // phase that turns the tomato up to amber, and idle/paused keep the plain
  // tomato at .pomodoro-icon's own muted weight -- no class at all, not a
  // "not resting" class, which is what makes idle/paused/rest all read as the
  // same quiet weight rather than rest reading as a second, different colour.
  var icon = slot && slot.querySelector('.pomodoro-icon');
  if (icon) icon.classList.toggle('pomodoro-icon-amber', pomodoroIsActiveWork(timer));
  if (statusEl) statusEl.classList.toggle('pomodoro-status-rest', resting);
}

// Render only -- never decides anything. No branch here mutates
// pomodoroDoc.timer or invents a next phase: an expired countdown just prints
// 00:00 (formatCountdown's own clamp) until the next fetchPomodoro() call
// replaces pomodoroDoc with whatever the daemon actually settled on.
function renderPomodoro() {
  var statusEl = document.querySelector('span#pomodoro-status');
  var toggleBtn = document.querySelector('button#pomodoro-toggle');
  // The null-doc guard: before the first fetch resolves there is
  // no timer to read at all, and the server-rendered markup (the plain tomato,
  // the plain mark) is already the correct anti-flicker default -- so this
  // returns before touching the favicon or the glyph, exactly as it already did
  // before either existed.
  if (!pomodoroDoc) return;
  var timer = pomodoroDoc.timer;
  if (!timer) {
    // No timer running is a real state, not an error: show the configured
    // work length as a calm, honest default, never a countdown.
    if (statusEl) statusEl.textContent = 'Idle (' + pomodoroDoc.settings.workMin + ' min)';
  } else {
    var ms = pomodoroRemainingMs(timer, pomodoroOffset, Date.now());
    var position = pomodoroCyclePosition(timer.phase, pomodoroDoc.cycle, pomodoroDoc.settings.longEvery);
    var text = pomodoroPhaseLabel(timer.phase);
    // The dot only ever separates a position from the countdown -- a long break,
    // which carries no position, keeps the plain 'Long break 12:34' shape this
    // read before positions existed.
    text += position ? ' ' + position + ' · ' + formatCountdown(ms) : ' ' + formatCountdown(ms);
    if (timer.paused) text += ' (paused)';
    if (statusEl) statusEl.textContent = text;
  }
  if (toggleBtn) {
    var on = !!(timer && !timer.paused);
    var label = pomodoroSwitchLabel(pomodoroSwitchAction(timer));
    toggleBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('title', label);
  }
  renderPomodoroFavicon(timer);
  renderPomodoroGlyph(timer);
  pomodoroSyncForm();
}

// Keeps the (collapsed-by-default) settings panel showing the daemon's actual
// values, not just whatever was there at page load -- a reader who opens it
// after another tab changed a duration should see the current numbers.
//
// Only ever writes while the panel is CLOSED. This is the whole fix for "I type
// a number, move to the next field, and the first one snaps back": renderPomodoro
// runs once a SECOND (the local repaint tick), and every one of those runs used
// to rewrite every field except the one holding focus -- so the value you had
// just typed and tabbed away from was overwritten within a second, every time,
// while the daemon still held the old number because nothing had been saved yet.
// Skipping the focused field alone was never enough: an edit survives leaving
// the field, and only Save ends it. A closed panel has no edit in progress to
// destroy, and syncing there is what makes the values fresh at the moment it
// opens -- at most one poll interval stale -- so no separate open-time sync is
// needed.
function pomodoroSyncForm() {
  var form = document.querySelector('form#pomodoro-settings-form');
  if (!form || !pomodoroDoc) return;
  var panel = document.querySelector('details#pomodoro-settings');
  if (panel && panel.open) return;
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
  var notifyRounds = form.querySelector('input[name="notifyRounds"]');
  // The three cue pickers, synced the same way and on the same
  // condition as every field above -- each is its own <select>, so this is
  // what makes "reverting a change without saving leaves the stored cue
  // untouched" true: a preview (onPomodoroCueChange below) only
  // ever posts to /api/pomodoro/preview, never writes pomodoroDoc.settings, so
  // the next sync (panel closed, same as any other abandoned edit) overwrites
  // whatever the picker was showing with the daemon's actual stored value.
  var cueWork = form.querySelector('select[name="cueWork"]');
  var cueBreak = form.querySelector('select[name="cueBreak"]');
  var cueLongBreak = form.querySelector('select[name="cueLongBreak"]');
  // The status item's two preferences, synced on the same condition as every
  // field above -- this panel is the only place either is editable, so a reader
  // who hid the item from its own popover finds the box that brings it back
  // already showing the truth rather than a default.
  var menubarCountdown = form.querySelector('input[name="menubarCountdown"]');
  var menubarHidden = form.querySelector('input[name="menubarHidden"]');
  if (workMin && active !== workMin) workMin.value = s.workMin;
  if (breakMin && active !== breakMin) breakMin.value = s.breakMin;
  if (longBreakMin && active !== longBreakMin) longBreakMin.value = s.longBreakMin;
  if (longEvery && active !== longEvery) longEvery.value = s.longEvery;
  if (notify && active !== notify) notify.checked = !!s.notify;
  if (notifyRounds && active !== notifyRounds) notifyRounds.checked = !!s.notifyRounds;
  if (cueWork && active !== cueWork) cueWork.value = s.cueWork;
  if (cueBreak && active !== cueBreak) cueBreak.value = s.cueBreak;
  if (cueLongBreak && active !== cueLongBreak) cueLongBreak.value = s.cueLongBreak;
  if (menubarCountdown && active !== menubarCountdown) menubarCountdown.checked = !!s.menubarCountdown;
  // The one inversion in this form, and one of only two places it exists (the
  // other is onPomodoroSettingsSubmit below): the CONTROL is 'Show in menu bar'
  // and the KEY is 'menubarHidden', so ticked is stored-false. See the checkbox's
  // own comment in src/pomodoro-widget.mjs for why the control is the positive
  // one rather than the key being renamed.
  if (menubarHidden && active !== menubarHidden) menubarHidden.checked = !s.menubarHidden;
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
    // comment for why that is what makes two tabs agree.
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

// One switch, three transitions -- see this section's header comment. Before the
// first fetch resolves there is no doc to decide against, and guessing 'ensure'
// there could start a pomodoro against a daemon that already has one running,
// so a click that early does nothing at all.
function onPomodoroToggleClick() {
  if (!pomodoroDoc) return;
  postPomodoro(pomodoroSwitchAction(pomodoroDoc.timer));
}

// The Restart/Forward pair. Always present, so unlike onPomodoroToggleClick above there is no
// pomodoroDoc-shaped decision to make before posting -- both routes are
// bodyless no-ops server-side against an idle daemon (src/pomodoro.mjs
// forwardTimer/restartTimer, both a no-op against '!doc.timer'), so a click
// before the first fetch resolves or while idle is safe to send exactly like
// any other click; postPomodoro applies whatever comes back the same way
// every other pomodoro write here does, which is what makes the countdown
// move instantly in THIS tab. Every other open tab picks the same change up
// through the widget's own existing sync -- fetchPomodoro's POMODORO_POLL_MS
// poll, the one mechanism this file already has for "another tab changed the
// timer" -- rather than this reaching for a second one.
function onPomodoroForwardClick() {
  postPomodoro('forward');
}

function onPomodoroRestartClick() {
  postPomodoro('restart');
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

// Closing the panel is the acknowledgement that the save landed, so it happens
// in the .then, never optimistically beside the post: mergeSettings
// (src/pomodoro.mjs) rejects an out-of-range field with a 400, postPomodoro
// turns that into a rejected promise, and a panel that closed anyway would have
// swallowed the refusal and left the reader believing a number that was never
// stored. Closing also re-opens pomodoroSyncForm above, which then writes the
// daemon's own saved values back over the form.
function closePomodoroSettings() {
  var panel = document.querySelector('details#pomodoro-settings');
  if (panel) panel.open = false;
  pomodoroDisarmReset(document.querySelector('button#pomodoro-reset'));
  pomodoroSyncForm();
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
    notifyRounds: !!form.querySelector('input[name="notifyRounds"]').checked,
    cueWork: form.querySelector('select[name="cueWork"]').value,
    cueBreak: form.querySelector('select[name="cueBreak"]').value,
    cueLongBreak: form.querySelector('select[name="cueLongBreak"]').value,
    menubarCountdown: !!form.querySelector('input[name="menubarCountdown"]').checked,
    // Negated, the second and last place this form inverts anything: the row
    // reads 'Show in menu bar', the key it writes is 'menubarHidden'. Ticked ->
    // hidden false -> the item comes back. Posted through the same
    // /api/pomodoro/settings patch as every other field here, never a second
    // save path of its own.
    menubarHidden: !form.querySelector('input[name="menubarHidden"]').checked,
  }).then(closePomodoroSettings);
}

// Picking a cue plays it immediately, before Save, even with the
// notify toggle off -- POST /api/pomodoro/preview (src/server.mjs, another
// owner's route) is what actually plays the file; this only asks for it. Fire
// and forget on purpose: a failed preview (offline tab, daemon mid-restart)
// must never surface an error to the reader or disturb the form -- no
// .then(), a swallowing .catch(), and no read of the response body, which is
// why postPomodoro (used by every other write here) is not reused -- that
// helper applies the response back into pomodoroDoc and rejects on a non-ok
// status, both wrong for something that is not a write at all (a preview
// must never touch pomodoroDoc.settings).
//
// Debounced per FIELD NAME, not by one shared timer across all three pickers:
// a held arrow key on ONE <select> can fire 'change' once per option it scans
// past, and previewing every one of those would be exactly the "chorus"
// this forbids -- so each new change on the same field cancels that
// field's own still-pending preview and restarts the wait, and only the value
// the reader actually lands on ever plays. A shared timer would additionally
// let a change on one picker cancel a still-pending preview on a DIFFERENT
// one, which is not the same bug this exists to fix and would drop a
// legitimate, independent preview on the floor. unref'd (matching
// pomodoroResetTimer above) so a pending preview is never the reason an
// in-process check's node process fails to exit on its own.
function onPomodoroCueChange(ev) {
  var el = ev.target;
  if (!el || el.tagName !== 'SELECT') return;
  // getAttribute('name'), not the bare '.name' property a real browser also
  // reflects: test/dom-stand-in.mjs models only the attribute (its Element
  // has no 'name' IDL reflection, unlike 'id' and 'disabled' -- see that
  // file's own comment on which properties genuinely need reflecting), and
  // this file already reads every other form field the same explicit way
  // (form.querySelector('input[name="..."]'), never form.workMin).
  var name = el.getAttribute('name');
  var value = el.value;
  if (pomodoroPreviewTimers[name]) clearTimeout(pomodoroPreviewTimers[name]);
  var timer = setTimeout(function () {
    delete pomodoroPreviewTimers[name];
    fetch('/api/pomodoro/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cue: value }),
    }).catch(function () { /* fire-and-forget: see this function's own comment */ });
  }, POMODORO_PREVIEW_DEBOUNCE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  pomodoroPreviewTimers[name] = timer;
}

// Ticking Notify fires one test banner immediately, before Save -- the same
// "audition it now" idea as the cue pickers above, for the half of the setting
// that is seen rather than heard. Without it, the only way to learn whether
// notifications actually arrive on this machine is to enable them and then wait
// out an entire interval, and if the answer is no (Notification Center refusing
// claude-board, the bundle never granted permission) nothing ever says so.
//
// On the way ON only. Unticking is not a thing to confirm, and firing there
// would be actively wrong: a banner saying notifications work, arriving because
// the reader just turned them off.
//
// Fire and forget for exactly the reasons onPomodoroCueChange states -- no
// .then(), a swallowing .catch(), no read of the body, and postPomodoro
// deliberately not reused, because this is not a write: the tick is not saved
// until Save, and the route it hits never touches pomodoro.json either. No
// debounce, unlike the pickers: a checkbox has one value per click, so there is
// no held-key run of intermediate values to collapse.
function onPomodoroNotifyChange(ev) {
  var el = ev.target;
  if (!el || el.getAttribute('name') !== 'notify') return;
  if (!el.checked) return;
  fetch('/api/pomodoro/notifyTest', {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(function () { /* fire-and-forget: see this function's own comment */ });
}

// The Store section's one control (ADR 71). Deliberately NOT routed through
// postPomodoro: this is not a pomodoro write, the route is /api/store/prune,
// and the response is a pair of counts rather than a pomodoro document --
// applying it into pomodoroDoc would corrupt the widget's whole state.
// credentials: 'same-origin' for the same reason every write here carries it:
// the session cookie is what authorises it (STORE_COOKIE_ACTIONS,
// src/server.mjs), and this page holds no secret of its own.
//
// One click, no arming and no preview, unlike the Reset button just above it in
// the same panel. That difference is the decision, not an oversight: the window
// is named deliberately at the call, so the click is not the deliberate part.
//
// THE WINDOW HAS NO DEFAULT. A field the reader has not filled in is refused
// here and says so, rather than being quietly filled with a plausible number --
// the daemon refuses it a second time (pruneStore's own 400) so the rule holds
// for any caller, not just this one.
function onStorePruneClick() {
  var input = document.querySelector('input#store-prune-days');
  var status = document.querySelector('span#store-prune-status');
  var days = parseInt((input && input.value) || '', 10);
  if (!(days > 0)) {
    if (status) status.textContent = 'Name a window first.';
    return;
  }
  if (status) status.textContent = 'Deleting…';
  fetch('/api/store/prune', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days: days }),
  }).then(function (r) {
    if (!r.ok) throw new Error('prune failed: ' + r.status);
    return r.json();
  }).then(function (data) {
    // The thread list on this page was server-rendered BEFORE the prune, so
    // every row for a board that just went now links to a 404. A reload is the
    // honest repair and needs no second rendering path: the shorter list is
    // also the reader's confirmation. Only when something actually went --
    // a prune that matched nothing would otherwise reload to an identical page
    // and read as if the click had done nothing at all, so that case says so
    // in words instead. Guarded rather than called bare: this script is also
    // run against a document stand-in with no location at all.
    if (data.boards > 0) {
      if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload();
      return;
    }
    if (status) status.textContent = 'Nothing older than that.';
  }).catch(function (err) {
    if (status) status.textContent = 'Prune failed: ' + ((err && err.message) || err);
  });
}

// A click anywhere outside the panel closes it -- the ordinary popover gesture,
// and the only way out other than the summary itself once the panel overlaps the
// page. Registered on 'document', so it sees the click AFTER it has bubbled all
// the way up: a click on the summary or inside the form is recognised by
// closest() finding the panel above it, and is left alone (closing on the
// summary's own click would fight the native <details> toggle and make the panel
// impossible to open). Nothing here calls stopPropagation.
function onDocumentClickClosePomodoroSettings(ev) {
  var panel = document.querySelector('details#pomodoro-settings');
  if (!panel || !panel.open) return;
  var t = ev.target;
  if (t && t.closest && t.closest('details#pomodoro-settings')) return;
  closePomodoroSettings();
}

// The fragment the menu bar item's 'Settings...' row navigates to
// (no setting is editable from the menu bar, so the item sends
// the reader here instead of growing a second panel). Handled explicitly rather
// than left to the browser's own fragment-auto-expand for a closed 'details' --
// that behaviour is recent and unevenly shipped, and nothing here gets to pick
// the reader's browser.
//
// Named as one constant used by both callers below, so the string the item
// opens and the string this recognises cannot drift apart.
var POMODORO_SETTINGS_FRAGMENT = '#pomodoro-settings';
function openPomodoroSettingsFromFragment() {
  // 'location' is whatever scope this script runs in supplies, read defensively
  // exactly as src/ui.mjs reads it for its own '#open-round' sentinel -- a
  // hash-less stand-in must not throw here.
  if (!location || location.hash !== POMODORO_SETTINGS_FRAGMENT) return;
  var panel = document.querySelector('details#pomodoro-settings');
  if (!panel) return;
  panel.open = true;
  // The widget sits in the page header, so this is only ever a no-op or a scroll
  // back UP -- but the reader arriving from the menu bar may well have left this
  // tab scrolled halfway down a long thread list, and a panel that opened
  // offscreen is indistinguishable from one that did not open.
  panel.scrollIntoView();
  // Spend the fragment once it has been acted on, so the NEXT 'Settings...' from the
  // popover works too. Without this, a browser handed the same URL again surfaces the
  // tab already parked on it and fires no 'hashchange' -- and the reader, who may well
  // have closed the panel since, gets a row that silently does nothing on second use.
  // replaceState rather than assigning location.hash: assigning it would push a history
  // entry and fire the very event this handler is standing in for. Guarded because the
  // stand-ins this script runs under do not all carry a history object.
  if (typeof history !== 'undefined' && history && history.replaceState) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function initPomodoroWidget() {
  var widget = document.querySelector('div#pomodoro-widget');
  if (!widget) return;
  var toggleBtn = document.querySelector('button#pomodoro-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', onPomodoroToggleClick);
  var restartBtn = document.querySelector('button#pomodoro-restart');
  if (restartBtn) restartBtn.addEventListener('click', onPomodoroRestartClick);
  var forwardBtn = document.querySelector('button#pomodoro-forward');
  if (forwardBtn) forwardBtn.addEventListener('click', onPomodoroForwardClick);
  var resetBtn = document.querySelector('button#pomodoro-reset');
  if (resetBtn) resetBtn.addEventListener('click', onPomodoroResetClick);
  var pruneBtn = document.querySelector('button#store-prune');
  if (pruneBtn) pruneBtn.addEventListener('click', onStorePruneClick);
  var form = document.querySelector('form#pomodoro-settings-form');
  if (form) form.addEventListener('submit', onPomodoroSettingsSubmit);
  // Delegated on the form rather than one listener per <select>: the three
  // cue pickers are the only <select> elements this form ever has, so
  // onPomodoroCueChange's own tagName check is all the scoping this needs.
  if (form) form.addEventListener('change', onPomodoroCueChange);
  // A second delegated 'change' on the same form, not a branch inside the one
  // above: each handler scopes itself to its own control (SELECT there, the
  // notify checkbox here) and they share nothing but the event.
  if (form) form.addEventListener('change', onPomodoroNotifyChange);
  document.addEventListener('click', onDocumentClickClosePomodoroSettings);
  // The other half of the fragment: a tab already sitting on this page when the
  // menu bar item asks for the panel only ever sees the hash change, never a
  // load. There the doc has long since been fetched and the (closed) panel has
  // been syncing all along, so opening it is all there is to do.
  window.addEventListener('hashchange', openPomodoroSettingsFromFragment);
  // Opened only once the OPENING fetch has settled, never inline beside this
  // call: pomodoroSyncForm deliberately never writes into an open panel (its own
  // comment), so a panel opened before the first fetch resolved would sit there
  // with every field blank until the reader closed it again. Settled, not
  // fulfilled -- a daemon that refuses the read still owes the reader the panel
  // they asked for, empty or not, and handling the rejection here is also what
  // keeps this call's own failure from surfacing as an unhandled one.
  fetchPomodoro().then(openPomodoroSettingsFromFragment, openPomodoroSettingsFromFragment);
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

/** Filter the thread index down to the sessions a query names. Matches on what
 * IDENTIFIES a session and nothing else — its title, its project folder, the
 * full `cwd` behind that folder, and the thread id — never on what was asked or
 * answered inside it. That is a deliberate narrowing of what this box used to
 * do (a full-text walk of every board file, rendering block-level result cards
 * below the list): the unit of an answer here is the session, so the box is a
 * filter over the list already on screen rather than a second, differently
 * shaped set of results underneath it. `GET /` no longer reads a single board
 * body to serve a query — `GET /api/search` is unchanged and is still the
 * full-text route.
 *
 * Case-insensitive substring, not word- or token-matching: the values matched
 * here are names and paths, where a partial prefix ("clau", "-board") is the
 * ordinary way anyone types at a filter. Exported for the check. */
export function filterThreads(threads, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return threads;
  return threads.filter(t => [t.title, folderName(t.cwd), t.cwd, t.thread]
    .some(v => typeof v === 'string' && v.toLowerCase().includes(q)));
}

/** Render the complete index page: the thread list (with rounds-left counts, round
 * counts and a visual live/settled distinction), filtered to `query` when one is
 * given — a plain GET-form round trip needing no client JS of its own. The
 * page's one script (`indexScript` above) only ever touches `.rel-time` text
 * content, the contents of `.thread-list`, and the pomodoro widget; nothing here
 * depends on it running, and the served list is correct as of the moment it was
 * served whether or not it ever does. */
export function renderIndexPage({ threads = [], query = '' } = {}) {
  const threadsHtml = renderThreadRows({ threads, query });

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
      ${markSvg(36)}
      <h1>claude-board</h1>
    </div>
    <div class="index-head-actions">
      ${pomodoroWidget()}
      ${themeToggle()}
    </div>
  </header>

  <form class="search-form" action="/" method="get">
    <input class="search-input" type="text" name="q" placeholder="Filter sessions — by title, project folder or thread id…" value="${escAttr(query)}">
    <button class="search-btn" type="submit">Filter</button>
  </form>

  <!-- data-query carries the filter this list was rendered under, so patchRows can ask
       for the SAME rows without reading location: indexScript is executed with document
       and setInterval as its only injected globals (test/check-pomodoro-page.mjs's
       harness), and a reference to location there is a ReferenceError. -->
  <div class="thread-list" data-query="${escAttr(query)}">
    ${threadsHtml}
  </div>
</div>
<script type="module">${indexScript}</script>
</body>
</html>
`;
}
