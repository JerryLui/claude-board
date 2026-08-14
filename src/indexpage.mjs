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
import { styles, faviconLink, markSvg } from './styles.mjs';
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
 * page loaded appears without anyone reloading (ADR 77).
 *
 * Both of those fetches are also WOKEN by a push: the page subscribes to the
 * daemon-wide stream (`GET /api/events`, src/server.mjs's `handleStream` — the same
 * one the menu bar item holds) and every event on it runs the fetch that already
 * owns the state, so a change the daemon already knows about reaches the list and
 * the widget in a round trip instead of up to fifteen seconds later. See
 * `initIndexStream` at the foot of this script for what a push does and does not
 * carry. The tick is untouched by that and stays exactly as it was: it is the
 * fallback whenever the stream is down, and it is the only thing that ever re-labels
 * "a minute ago" on a row nothing has changed, which no push could do — nothing
 * happened, and that is precisely when the label moves. Small, dependency-free,
 * inline (QUIRKS.md "No external assets — not even mermaid, now three bare
 * sibling filenames"; an icon is not one of them),
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
 * lets a check extract `relTime` by name via `new Function('document',
 * 'setInterval', 'EventSource', indexScript + '; return relTime;')()` to pin its
 * boundaries directly, the same technique `extractUiFunction` already uses on `ui`.
 * The names are declared even though the extraction only wants one function back:
 * the body still runs top to bottom before it returns, so an undeclared name would
 * reach the host's globals just as it does at any other site.
 *
 * `relTime` takes `now` as an explicit second argument (falling back to
 * `Date.now()`) rather than reading the clock itself, so that technique can pin
 * fixed-timestamp behaviour deterministically instead of racing the wall clock.
 *
 * Four globals a real page always has are what this needs in scope: `document`,
 * `setInterval`, and — since the settings panel answers a URL fragment
 * (`openPomodoroSettingsFromFragment` below) — `window` and `location`, exactly
 * the pair `ui` already takes as `new Function('document', 'window', 'location',
 * 'EventSource', ui)`. A check driving the REAL page markup has to supply all four; the
 * function-extraction stand-ins above never reach the two new ones, because
 * `initPomodoroWidget` bails on a document with no `div#pomodoro-widget` in it
 * long before either is read.
 *
 * `EventSource` is the fifth, and the one this script REQUIRES nothing of: it is
 * read through `typeof` (`initIndexStream` below), so a scope without one runs the
 * whole script and simply never subscribes — which is exactly what the narrow
 * function-extraction stand-ins above do, and what a browser too old to have one
 * would do. test/check-index-live.mjs supplies it, as a driveable
 * `StandInEventSource` (test/dom-stand-in.mjs), because a stream a check can push
 * into by hand is the only way to prove "within a second" in milliseconds.
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
// One fetch at a time, and exactly one more owed if anything asked while that one
// was out. A daemon answering slower than its callers would otherwise accumulate an
// outstanding request per call, and responses can land out of order -- a slow first
// answer arriving after a fast second one differs from lastRowsHtml and patches the
// OLDER rows in over the newer ones.
//
// Dropping the overlapping call outright was right while the tick was the only
// caller: the next tick was fifteen seconds away and asked the same question, so the
// cost was one interval of a list that was at most one interval stale anyway. A push
// is a different caller making a different promise -- within a second -- and a store
// change landing during the round trip of the one before it is precisely what a drop
// loses: the answer already on the wire was rendered before that change existed, and
// nothing else was going to ask. Two boards posted two milliseconds apart is the
// whole window, and it is enough. So an overlapping call is REMEMBERED here and
// re-run once the outstanding fetch settles.
//
// Coalesced, not queued: however many calls arrive during one round trip, they owe
// exactly one more fetch between them, which keeps both properties this guard exists
// for -- never more than one request outstanding, and never two answers in flight
// that could cross, since the re-run only starts after the previous one has landed.
// Re-run on BOTH settle paths, for the same reason rowsInFlight is cleared after the
// catch rather than beside it: a failed fetch that swallowed the push it was hiding
// would strand the list for the life of the tab.
var rowsInFlight = false;
var rowsPending = false;

// The index fetches its rows and patches the LIST, never the page (ADR 77). Not a
// reload, and that is the load-bearing half -- replacing only the list's contents
// is what leaves the scroll position and whatever is typed in the search box
// exactly as they were, which a reload would throw away. That holds however this
// was called: it is the ONE way the list is ever updated, so a push (initIndexStream
// below) preserves the page exactly as the fifteen-second tick already does,
// because it is the same code doing it.
//
// This used to argue the page should not have a live connection at all -- "a page
// nobody stares at". The popover retired that argument: the reviewer now acts in the
// menu bar with this page on screen, so the two surfaces disagreeing for a tick is
// visible. What survives from it is everything below: one fetch at a time, the
// unchanged-html short circuit, and the swallowed failure.
//
// The query comes off the list element rather than the URL. 'location' is injected
// these days (see this export's header), so this is no longer "there is nothing else
// to read": data-query is the filter the list on screen was ACTUALLY rendered under,
// where location.search is a second copy of the same fact -- and the stand-ins that
// run this script do not all carry a 'search' at all.
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
  if (!list) return;
  if (rowsInFlight) { rowsPending = true; return; }
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
    // tab, which is a worse outcome than the pile-up it guards against. The
    // remembered call is paid off here, in the same place and for the same reason
    // -- and the flag is cleared BEFORE the re-run, so a push arriving during THAT
    // fetch is remembered again rather than lost to the one already being served.
    .then(function () {
      rowsInFlight = false;
      if (rowsPending) {
        rowsPending = false;
        patchRows();
      }
    });
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
//  - The header glyph alone reads pomodoroIsResting below to decide whether
//    it shows the plain tomato or the rest mark. A null phase (pomodoroDoc
//    still null, before the first fetch resolves) is not a break: the
//    predicate requires a real timer object, so a slow first load renders
//    the ordinary glyph, never flickers through rest. The tab's own favicon
//    is fixed and carries no phase at all (ADR 85).

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
'var TOMATO_ICON = ' + JSON.stringify(TOMATO_ICON) + ';\n' +
'var REST_ICON = ' + JSON.stringify(REST_ICON) + ';\n'
+ `
// Real values spliced in from src/pomodoro-widget.mjs (JSON.stringify, the
// same "embed the real source, never a hand copy" discipline
// formatCountdown.toString() already uses just above) --
// TOMATO_ICON/REST_ICON above are literally src/pomodoro-widget.mjs's own
// exports, not a second drawing that could drift from it.

// The header glyph's rest predicate: true only for a REAL timer, RUNNING
// (not paused), on a break or long break. Idle, paused -- in ANY phase,
// including mid-break -- and work all read false, and so does a timer
// pomodoroDoc has not been fetched yet (timer is null/undefined then, same
// as genuinely idle): "no poll has returned" and "idle" are
// indistinguishable on purpose, since a phase this is at most one poll
// interval stale about is not evidence of a break ("a null phase means no
// glyph change, never on break").
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
  // no timer to read at all, and the server-rendered markup (the plain
  // tomato) is already the correct anti-flicker default -- so this returns
  // before touching the glyph, exactly as it already did before the glyph
  // existed.
  if (!pomodoroDoc) return;
  var timer = pomodoroDoc.timer;
  if (!timer) {
    // No timer running is a real state, not an error -- and the state is the whole of
    // what this line says. The configured work length used to sit here in brackets
    // ("Idle (25 min)") as a calm default naming what a start would give you. It is gone
    // for the reason bin/menubar.m's cb_derive already refused it: a duration that is not
    // counting down, in the place a countdown normally sits, reads as a countdown that
    // has stopped. The number is still one field away in the settings panel below, which
    // is where a number that can be EDITED belongs. The Popover says 'Idle' too, and the
    // two surfaces now agree in this state as in every other.
    if (statusEl) statusEl.textContent = 'Idle';
  } else {
    var ms = pomodoroRemainingMs(timer, pomodoroOffset, Date.now());
    var position = pomodoroCyclePosition(timer.phase, pomodoroDoc.cycle, pomodoroDoc.settings.longEvery);
    var text = pomodoroPhaseLabel(timer.phase);
    // The dot is the widget's one separator between the phase and its countdown,
    // position or no position -- a long break reads 'Long break · 12:34' the same
    // as a work or break interval reads 'Work 1/2 · 25:25'. The popover's
    // cb_status_label (bin/menubar.m) renders the same shape.
    text += position ? ' ' + position + ' · ' + formatCountdown(ms) : ' · ' + formatCountdown(ms);
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
  var bannerLevel = form.querySelector('select[name="bannerLevel"]');
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
  // field above -- this panel is the only place either is editable OR reachable
  // (the popover carries no hide row), so a reader who hid the item finds the box
  // that brings it back already showing the truth rather than a default.
  var menubarCountdown = form.querySelector('input[name="menubarCountdown"]');
  var menubarHidden = form.querySelector('input[name="menubarHidden"]');
  if (workMin && active !== workMin) workMin.value = s.workMin;
  if (breakMin && active !== breakMin) breakMin.value = s.breakMin;
  if (longBreakMin && active !== longBreakMin) longBreakMin.value = s.longBreakMin;
  if (longEvery && active !== longEvery) longEvery.value = s.longEvery;
  if (notify && active !== notify) notify.checked = !!s.notify;
  if (bannerLevel && active !== bannerLevel) bannerLevel.value = s.bannerLevel;
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

// Each field is looked up and added to the patch independently, rather than one
// object literal read straight off the form the way this used to be written --
// ADR 103's off shape (pomodoroSettingsGear, src/pomodoro-widget.mjs) strips this
// same form down to three fields (bannerLevel, menubarHidden, and the Master
// switch, which posts through its own onPomodoroEnabledChange below and is never
// collected here), so a form that no longer HAS a workMin input must not be asked
// for its '.value'. mergeSettings (src/pomodoro.mjs) already merges a partial
// patch field by field and drops keys it does not recognize, which is what makes
// sending only what is actually on screen both safe and sufficient -- nothing
// here has to know which shape it is running against.
function onPomodoroSettingsSubmit(ev) {
  ev.preventDefault();
  var form = ev.target;
  var patch = {};
  var workMin = form.querySelector('input[name="workMin"]');
  if (workMin) patch.workMin = parseInt(workMin.value, 10);
  var breakMin = form.querySelector('input[name="breakMin"]');
  if (breakMin) patch.breakMin = parseInt(breakMin.value, 10);
  var longBreakMin = form.querySelector('input[name="longBreakMin"]');
  if (longBreakMin) patch.longBreakMin = parseInt(longBreakMin.value, 10);
  var longEvery = form.querySelector('input[name="longEvery"]');
  if (longEvery) patch.longEvery = parseInt(longEvery.value, 10);
  var notify = form.querySelector('input[name="notify"]');
  if (notify) patch.notify = !!notify.checked;
  var bannerLevel = form.querySelector('select[name="bannerLevel"]');
  if (bannerLevel) patch.bannerLevel = bannerLevel.value;
  var cueWork = form.querySelector('select[name="cueWork"]');
  if (cueWork) patch.cueWork = cueWork.value;
  var cueBreak = form.querySelector('select[name="cueBreak"]');
  if (cueBreak) patch.cueBreak = cueBreak.value;
  var cueLongBreak = form.querySelector('select[name="cueLongBreak"]');
  if (cueLongBreak) patch.cueLongBreak = cueLongBreak.value;
  var menubarCountdown = form.querySelector('input[name="menubarCountdown"]');
  if (menubarCountdown) patch.menubarCountdown = !!menubarCountdown.checked;
  // Negated, the one place left this form inverts anything: the row reads 'Show
  // in menu bar', the key it writes is 'menubarHidden'. Ticked -> hidden false ->
  // the item comes back.
  var menubarHidden = form.querySelector('input[name="menubarHidden"]');
  if (menubarHidden) patch.menubarHidden = !menubarHidden.checked;
  postPomodoro('settings', patch).then(closePomodoroSettings);
}

// The Master switch (ADR 103): unlike every field collected above, this one
// persists on its own 'change', immediately, rather than waiting for Save --
// see the row's own comment in src/pomodoro-widget.mjs for why bundling it into
// onPomodoroSettingsSubmit's patch was rejected. Real postPomodoro, not the
// fire-and-forget fetch onPomodoroNotifyChange/onPomodoroCueChange below use for
// an audition: flipping this decides which of the two page shapes the NEXT load
// renders (deliverable 2), so a write that failed must be seen to fail rather
// than look like it landed. No debounce -- a checkbox has one value per click,
// the same reasoning onPomodoroNotifyChange's own comment gives for skipping one.
function onPomodoroEnabledChange(ev) {
  var el = ev.target;
  if (!el || el.getAttribute('name') !== 'enabled') return;
  postPomodoro('settings', { enabled: !!el.checked }).then(function () {
    // ADR 104: flipping the Master switch changes the page's SHAPE -- full
    // widget vs reduced panel, header countdown, the Timer surfaces, all of
    // it -- so a successful write repairs by reloading, the same honest fix
    // onStorePruneClick already uses above, never a second client-side
    // rendering path. The one-shot reopen this toggle alone gets (no general
    // panel-open memory) rides the URL itself rather than any separate flag
    // storage: parking POMODORO_SETTINGS_FRAGMENT on the URL before reloading
    // means the freshly loaded page's own openPomodoroSettingsFromFragment --
    // already wired at startup below, and already the thing that opens AND
    // SPENDS this exact fragment for the menu bar's own gear -- opens the
    // settings panel once and clears the fragment straight back out, so an
    // ordinary later reload finds nothing parked and stays closed, same as
    // today.
    //
    // history.replaceState, never assigning location.hash -- the same form
    // (and the same reason) openPomodoroSettingsFromFragment's own consume
    // step below already uses: assigning location.hash queues an async
    // 'hashchange' AND pushes a history entry. A reload started right after
    // happens to outrun that queued event in every browser this was tried on,
    // but nothing guarantees the ordering, and the pushed entry would make
    // the reviewer's first Back press after the flip a no-op (back to the
    // same URL, fragment and all). replaceState rewrites the URL the reload
    // rereads with no queued event and no new entry. Guarded the same
    // defensive way as every other history/location access in this file:
    // this script also runs against stand-ins that supply neither.
    if (typeof history !== 'undefined' && history && history.replaceState &&
        typeof location !== 'undefined' && location && typeof location.reload === 'function') {
      history.replaceState(null, '', location.pathname + location.search + POMODORO_SETTINGS_FRAGMENT);
      location.reload();
    }
    // A failed write (the .catch this deliberately has none of) reloads
    // nothing and leaves the checkbox showing whatever the reader just set --
    // visibly out of step with what actually persisted, which is the failure
    // staying visible that AC 3 asks for, unchanged from before this handler
    // ever reloaded anything.
  });
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
  // The tagName check alone used to be the whole of the scoping (the three cue
  // pickers were the only <select> this form had) -- ticket 03's Banner level
  // control is a second one, and it is not a cue: a bug here would fire a
  // '/api/pomodoro/preview' request carrying a Banner-level STRING as the cue
  // every time the reader picked a level. Named exactly, the same discipline
  // TOGGLE_KEYS/CUE_KEYS (src/pomodoro.mjs) already use for their own closed
  // sets, rather than an ever-growing exclusion list.
  if (name !== 'cueWork' && name !== 'cueBreak' && name !== 'cueLongBreak') return;
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

// The fragment the menu bar popover's gear navigates to -- a glyph with no text
// and no ellipsis, not a row (no setting is editable from the menu bar, so the
// item sends the reader here instead of growing a second panel). Handled explicitly rather
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
  // Spend the fragment once it has been acted on, so the NEXT press of the popover's
  // gear works too. Without this, a browser handed the same URL again surfaces the
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
  // A third delegated 'change', same reasoning -- the Master switch scopes
  // itself to name="enabled" and shares nothing with the two above but the form
  // and the event. Present on both shapes pomodoroWidget() can render (this
  // form always has the row -- see the row's own comment in
  // src/pomodoro-widget.mjs), so this listener is never a no-op registration.
  if (form) form.addEventListener('change', onPomodoroEnabledChange);
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

// fetchPomodoro with its rejection swallowed, for the stream's callers only. A push
// that arrives just as the daemon goes down, or a reconnect racing a restart, must
// leave the widget showing the last thing it knew -- exactly as a failed patchRows
// leaves the list alone -- and a rejected promise returned into an event listener is
// nobody's to catch. The POMODORO_POLL_MS interval keeps calling fetchPomodoro bare,
// unchanged: that path is the backstop, and it gets another go in fifteen seconds.
function wakePomodoro() {
  fetchPomodoro().catch(function () { /* see this function's own comment */ });
}

// The daemon-wide stream (GET /api/events, src/server.mjs's handleStream): the same
// connection the menu bar item holds, opened once more per open index tab. Without
// it this page waits up to fifteen seconds for news the daemon already has, which is
// visible the moment the reviewer presses something in the menu bar popover with
// this page on screen.
//
// A push WAKES A FETCH, and nothing here reads what it carried. The 'waiting' event
// is a count, not rows, and 'pomodoro' is a document that was current at the instant
// it was sent -- while patchRows above is the one place that knows how to patch the
// list without disturbing the page, and fetchPomodoro is the one place that
// recomputes the clock offset the countdown is rendered from. So neither listener
// below takes an argument at all: what a push says is only 'ask again now'.
//
// 'open' fires on the first connection AND on every automatic reconnect, which is
// exactly the set of moments this tab may have missed something: nothing backfills
// events sent while it was disconnected, so coming back live means asking what the
// state is NOW. That is what makes an index left open through a daemon restart go
// live again on its own. The first 'open' costs one extra pair of fetches at load,
// which is the price of not keeping a 'have I connected before' flag to tell a
// connect from a reconnect -- and the rows fetch would have happened on the first
// tick anyway. src/ui.mjs's board stream resyncs on 'open' for the same reason.
//
// No reconnect and no backoff written here: EventSource does it natively, which is
// the whole reason this page subscribes with one. Guarded on typeof exactly as
// src/ui.mjs guards its own: this script also runs under stand-ins with no
// EventSource in scope at all, and a page that cannot subscribe still has its tick.
// The session cookie the tab already holds is what authorises the stream -- an
// EventSource sends it same-origin, like the board page's per-board one, so nothing
// here needs a secret of its own.
//
// Only the two events the daemon already broadcasts (broadcastWaiting and
// broadcastPomodoro, src/server.mjs) are listened for. A row change with no
// broadcast behind it -- a prune, a last-activity stamp drifting -- keeps arriving on
// the tick; teaching the daemon a new event is a decision of its own, not a line
// added here.
//
// ponytail: one held connection per open index tab, the shape a board tab already
// has. Ceiling: a reviewer who leaves a dozen index tabs open for days costs the
// daemon a dozen idle subscribers. Upgrade path if that ever bites: drop the
// subscription while the tab is hidden and re-open it on visibilitychange, which is
// exactly what the 'open' -> re-fetch path above already covers.
function initIndexStream() {
  if (typeof EventSource === 'undefined') return;
  var es = new EventSource('/api/events');
  es.addEventListener('open', function () { patchRows(); wakePomodoro(); });
  es.addEventListener('waiting', function () { patchRows(); });
  es.addEventListener('pomodoro', function () { wakePomodoro(); });
}
initIndexStream();
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
 * served whether or not it ever does.
 *
 * `pomodoroEnabled` (ADR 103, default true — "a settings document without the new
 * key reads as on") is the one piece of pomodoro state this function ever takes: a
 * plain boolean, decided by the CALLER (src/server.mjs's own `GET /` route reads
 * `settings.enabled` off pomodoro.json for it) rather than read here, so this
 * function stays what it always was — a pure render over its arguments, no fs
 * access of its own. It does nothing but pick which of pomodoroWidget()'s two
 * shapes renders into the header below; every other pomodoro field still reaches
 * the page the way src/pomodoro-widget.mjs's own header comment describes, one
 * fetch after load. */
export function renderIndexPage({ threads = [], query = '', pomodoroEnabled = true } = {}) {
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
      ${pomodoroWidget({ enabled: pomodoroEnabled })}
      ${themeToggle()}
    </div>
  </header>

  <form class="search-form" action="/" method="get">
    <input class="search-input" type="text" name="q" placeholder="Filter sessions — by title, project folder or thread id…" value="${escAttr(query)}">
    <button class="search-btn" type="submit">Filter</button>
  </form>

  <!-- data-query carries the filter this list was rendered under, so patchRows can ask
       for the SAME rows without reading location: this is the filter the rows on screen
       were actually rendered under, and the check harnesses that run indexScript against
       this markup (test/check-pomodoro-page.mjs, test/check-index-live.mjs) inject a
       location carrying a hash and nothing else. -->
  <div class="thread-list" data-query="${escAttr(query)}">
    ${threadsHtml}
  </div>
</div>
<script type="module">${indexScript}</script>
</body>
</html>
`;
}
