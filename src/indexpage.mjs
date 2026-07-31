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

import { styles } from './styles.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

/** A question block counts as pending until it has an *answered* entry: missing
 * (never submitted), explicit `unanswered`, and `deferred` are all still open work
 * from the reviewer's point of view. */
function pendingCount(board) {
  const answers = board.answers || {};
  return (board.blocks || []).filter(b => {
    if (b.kind !== 'question') return false;
    const a = answers[b.id];
    return !a || a.status !== 'answered';
  }).length;
}

/** A board is "live and waiting" while it has a posted round nobody has sent yet —
 * the same signal `POST /api/board/:id/submit` clears. */
function isLiveBoard(board) {
  return (board.rounds || []).some(r => r.status === 'open');
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
    threads.push({
      thread,
      boardId: primary.id,
      cwd,
      title: primary.title || '',
      pending,
      live: liveBoards.length > 0,
      updatedAt,
      boardCount: group.length,
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

function threadRow(t) {
  const liveCls = t.live ? ' live' : '';
  const pendingCls = t.pending > 0 ? 'pending-badge has-pending' : 'pending-badge zero';
  const cwdLabel = t.cwd || '(no project directory)';
  return `
<a class="thread-item${liveCls}" href="/b/${escAttr(t.boardId)}" data-thread-id="${escAttr(t.thread)}" data-pending="${t.pending}" data-live="${t.live}">
  <div class="thread-main">
    <div class="thread-cwd">${t.live ? '<span class="live-dot" aria-hidden="true"></span> ' : ''}${escHtml(cwdLabel)}</div>
    <div class="thread-meta">${escHtml(t.thread)} · ${escHtml(t.title || 'untitled')} · updated ${escHtml(formatDate(t.updatedAt))}</div>
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

/** Render the complete index page: the thread list (with pending counts and a
 * visual live/settled distinction) plus, when `query` is non-empty, the archive
 * search results inline — a plain GET-form round trip, no client JS required. */
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
</body>
</html>
`;
}
