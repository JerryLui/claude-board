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
import { styles } from './styles.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';

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
function pendingCount(board) {
  const answers = board.answers || {};
  return (board.blocks || []).filter(b => {
    if (b.kind !== 'question') return false;
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
    group.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const liveBoards = group.filter(isLiveBoard);
    const primary = liveBoards[0] || group[0];
    const pending = group.reduce((sum, b) => sum + pendingCount(b), 0);
    const cwd = (group.find(b => b.cwd) || {}).cwd || null;
    const updatedAt = group.reduce((max, b) => (String(b.updatedAt) > max ? b.updatedAt : max), group[0].updatedAt);
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
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
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
  return `
<a class="thread-item${liveCls}" href="/b/${escAttr(t.boardId)}" data-thread-id="${escAttr(t.thread)}" data-pending="${t.pending}" data-live="${t.live}">
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
