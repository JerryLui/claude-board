// Pure, DOM-free facts about a round, so they are checkable with no browser
// (test/check-pure.mjs) AND shared by the two sides that must agree about them:
// src/render.mjs renders them server-side, src/ui.mjs embeds each one's literal
// source via `.toString()` and runs the same code in the tab. This module is the
// one place either can import from -- src/ui.mjs cannot import src/render.mjs
// (render.mjs imports the client script, so the edge would be circular).
// See PROTOCOL.md "Board document" for `rounds`.
//
// ADR.md entry 42: the header used to carry a `round N of M` badge (`badgeLabel`,
// deleted from here) whose click routed through the same `jumpToOpenRound`
// (src/ui.mjs) the pager's own chevrons already did -- three doors onto one
// mechanism, and a round named twice (the pager dock's caption is now the only
// place a round is named at all). `roundNumberLabel` below is what survives.

// "Round N", the half of a round's name that is only ever the number. The pager
// used to print the whole label below on every entry, title and all, and a
// five-round thread turned it into five ellipsed stubs -- "Round 1 ·...",
// "Round 2 · Pag...", "Round 3 · Pa..." -- naming nothing while costing the
// width of a name, and the truncation also ate the '.round-page-owed' dot that
// marks the round still owing an answer (the ::after sits past the clipped
// text). Titles are agent-supplied and `ask` requires one on every call, so
// their length is not something a control holding every round can assume
// anything about. The pager's entries are bare numerals now, under a caption
// naming the round the reviewer is actually on; every entry still carries its
// full label as its accessible name and its hover title.
export function roundNumberLabel(n) {
  return 'Round ' + n;
}

// A round's own full name: the label src/render.mjs prints at the top of an
// ordinary round, where there is a line's worth of room for it, the pager's
// caption for the current round, and every pager entry's accessible name and
// hover title (ADR.md entry 42 -- "a pill at the bottom naming the rounds").
// Built on roundNumberLabel above so the number the pager shows and the number
// the heading opens with are one string, not two that could drift.
// Embedded into the client script by `.toString()`, same discipline as every
// other export here (see this file's own header comment), since the pager is
// rebuilt live whenever a round arrives or is sent.
export function roundPageLabel(n, title) {
  return title ? roundNumberLabel(n) + ' · ' + title : roundNumberLabel(n);
}

// Is this list of blocks a PAGE -- one rendered artifact filling the viewport,
// rather than a stage in a column? ADR.md entry 33: inferred from shape, never
// declared, so nothing enters the protocol. Entry 42 made it a question about a
// ROUND rather than about a whole board: a thread keeps its single board, so the
// artifact round stays a full-viewport page for good and the question round that
// follows it is an ordinary page next door. src/render.mjs asks it of a round's
// blocks when it renders, and re-exports it as isPageBoard for a whole board;
// src/ui.mjs asks it of the same blocks again on every flip, to decide whether
// the page now on screen is laid out as a page board.
//
// A block whose reference failed to resolve is excluded deliberately: there is
// no stage to fill anything with, only the red "could not resolve" card, and a
// page board's chrome would render that error alone across the viewport.
export function isPageRound(blocks) {
  return blocks.length === 1 && blocks[0].kind === 'html' && !blocks[0].error;
}

// Every question block on the board, in display order, INCLUDING those nested in a
// question's `context` array or a compare block's sides.
//
// src/board.mjs's `findBlock` recurses through exactly these nestings, and
// src/render.mjs renders a nested question as a fully live widget that src/ui.mjs
// collects on Send -- but the packet and the unanswered synthesis used to walk
// top-level `board.blocks` only. The reviewer answered the question, the
// answer was persisted to `board.answers`, and the agent was never told: for a tool
// whose whole job is carrying answers back, a silently dropped answer is the worst
// thing it can do. One traversal, used by everything that asks "which questions are
// on this board".
//
// Moved here from src/board.mjs (still re-exported from there, so every existing
// `from './board.mjs'` import keeps working) so `roundIsAwaited` below -- which
// needs this same walk for its legacy fallback -- can be pure and imported by both
// server.mjs/indexpage.mjs AND spliced by `.toString()` into the client script
// (src/ui.mjs), exactly like isPageRound above already is. Reversing the
// board.mjs -> badge.mjs edge back the other way (badge.mjs -> board.mjs) would be
// circular: board.mjs already imports isPageRound from here.
export function questionBlocks(board) {
  const out = [];
  const visit = b => {
    if (!b) return;
    if (b.kind === 'question') {
      out.push(b);
      (b.context || []).forEach(visit);
      // choose-between-rendered-variants: an option's own block can
      // itself be a nested question (the same generality context/compare
      // already allow), so its answer has to reach applySubmit's answerable
      // set and buildPacket the same way a context/compare-nested question's
      // does.
      (b.options || []).forEach(o => visit(o.block));
    }
    if (b.kind === 'compare') {
      visit(b.left?.block);
      visit(b.right?.block);
    }
  };
  for (const b of board.blocks) visit(b);
  return out;
}

// Is round `r` of `board` *awaited* -- is the `ask` call that posted it still
// blocked on it, so a submit reaches an agent that is listening (CONTEXT.md
// "Awaited")? A round carrying a question always is; a page board is only when
// the call said `wait: true` (ADR.md entry 45). This is the ONE property behind
// three surfaces that must never drift apart: sendability (src/server.mjs
// handleSubmit), the index badge and tab mark (src/indexpage.mjs
// openAwaitedRounds), and the arrival notification (src/ui.mjs markPendingRound).
//
// `r.awaited` (stamped at mint time by `mintAwait`, src/board.mjs, and cleared
// again by `closeLapsedAwaitedRounds` below the moment its deadline passes) is
// the source of truth for any round minted after ADR.md entry 45 landed -- read
// directly, no re-derivation. A round minted BEFORE that carries neither
// `awaited` nor `awaitDeadline` at all (`undefined`, not `false`): for exactly
// those legacy rounds this falls back to the OLD shape-based inference a page
// board's awaited-ness used to be inferred from -- a question block anywhere in
// the round -- so a board already on disk keeps behaving exactly as it always
// did rather than every one of its open question rounds silently dropping out of
// the badge, the tab mark and the notification the moment this code shipped.
//
// Shared rather than reimplemented per call site (src/server.mjs's
// drainUndeliveredComments used to keep its own copy) -- two definitions of "is
// this round awaited" is exactly the kind of drift CONTEXT.md's "Awaited" entry
// exists to prevent.
export function roundIsAwaited(board, r) {
  if (!r) return false;
  if (typeof r.awaited === 'boolean') return r.awaited;
  return questionBlocks(board).some(q => q.round === r.n);
}

// The other half of the flag above: `mintAwait` (src/board.mjs) stamps
// `awaited: true` when the round is born, and THIS is what unstamps it when the
// wait it describes dies of its own deadline. Without it `awaited` was write-once
// -- the property CONTEXT.md's "Awaited" entry defines for three surfaces at once
// stayed true forever, so a round nobody was listening to any more still counted
// in the index badge, still swallowed its comments before the drain could carry
// them (drainUndeliveredComments, src/server.mjs), and still answered a repeat
// post as a resumable round against a deadline that had already lapsed.
//
// `awaitDeadline` is deliberately LEFT in place: it is the record of when the
// wait died, it is what the lapse test below reads, and it is what lets the
// dedupe in src/server.mjs refuse to resume a round whose time is up. Only the
// live flag moves.
//
// Called from `readBoard` (src/store.mjs), the one choke point every reader of a
// stored board goes through, so no surface has to remember to ask a clock: a
// board read after its wait died is already telling the truth about itself. A
// sweep on read rather than a write on read -- the flip persists the next time
// anything writes the board, and until then every in-memory reader agrees.
// ponytail: O(rounds) per board read, which is a handful of entries; if a thread
// ever grows rounds by the thousand, hoist this behind a "latest round only"
// check, since an older round's deadline has necessarily lapsed already.
export function closeLapsedAwaitedRounds(board, nowMs = Date.now()) {
  let closed = 0;
  for (const r of (board && board.rounds) || []) {
    // `=== true` only, matching roundIsAwaitedOpen: a legacy round carries no
    // `awaited` key at all and has no deadline to lapse, so it is never touched.
    if (r.awaited === true && r.status === 'open' && r.awaitDeadline
      && Date.parse(r.awaitDeadline) <= nowMs) {
      r.awaited = false;
      closed += 1;
    }
  }
  return closed;
}

// Has this round's wait already died -- is there a deadline on it that the clock
// has passed? True whether or not `closeLapsedAwaitedRounds` has swept it yet,
// and true for the rest of the round's life, which is what the `requestId`
// dedupe (src/server.mjs) needs: the round it is about to resume must be one an
// agent can still be handed back, and a lapsed one never is again.
export function roundWaitLapsed(round, nowMs = Date.now()) {
  return !!round && !!round.awaitDeadline && Date.parse(round.awaitDeadline) <= nowMs;
}

// --- the waiting signal (SPEC_AWAITED.md ticket 03, ADR.md entries 45-47) ---
//
// Two different questions, two different functions, deliberately never folded
// into one. `roundIsAwaitedOpen` below is a fact about the STORED board alone --
// `status`/`awaited`, nothing else -- so it is safe for src/render.mjs to call
// at render time: same board, same answer, forever (this file's own "pure,
// DOM-free facts" contract, and what keeps a page's rendered markup a
// deterministic function of its JSON -- examples/sample-board.html and
// test/check-sample-board.mjs pin exact bytes, which a render-time `Date.now()`
// would silently break). `roundIsCurrentlyAwaited` ADDS the one fact that is
// NOT stored anywhere -- has the deadline itself already passed -- which is why
// it takes `nowMs` and why only src/ui.mjs ever calls it: the actual "38m left"
// figure, and the live downgrade to read-only the moment a wait dies (AC 12),
// are both client-only computations, following the exact precedent
// src/pomodoro-widget.mjs's own header comment sets for the identical problem
// ("No countdown text is ever rendered server-side"). `nowMs` is threaded
// through rather than read from `Date.now()` internally so the SAME code
// (spliced into the client script via `.toString()`, same discipline as every
// other export here) produces the same answer under a check's fixed clock as
// it does in a real tab.

// Is this round open AND was it minted awaited (`=== true`, never merely
// truthy -- a legacy round carries neither key at all, `undefined`, and that
// must read as not awaited)? A sent/timed-out/archived round is never this
// (AC 11's "no countdown" side), regardless of what `awaitDeadline` still says
// -- ticket 01's own contract is that the deadline survives a send unchanged,
// so gating on its mere presence would show a countdown on a round that is
// long since closed.
export function roundIsAwaitedOpen(round) {
  return !!round && round.status === 'open' && round.awaited === true;
}

// Everything roundIsAwaitedOpen asks, PLUS the one fact only a wall clock can
// answer: has `awaitDeadline` already passed. This is what actually decides
// whether a countdown may show right now (AC 6, AC 11) and whether the awaited
// page's compose/send surface is still live (AC 4, AC 5, AC 12) -- client-side
// only, per this section's own header comment.
export function roundIsCurrentlyAwaited(round, nowMs) {
  return roundIsAwaitedOpen(round) && !!round.awaitDeadline && Date.parse(round.awaitDeadline) > nowMs;
}

// "38m left" -- always minutes, always rounded up, never zero while the gate
// above still holds (a round that just crossed the deadline stops being
// "currently awaited" at all, rather than ever printing "0m left"). `null`
// covers every other state, which is what lets a caller treat "no string" as
// "render nothing" without re-deriving the gate itself.
export function roundCountdownText(round, nowMs) {
  if (!roundIsCurrentlyAwaited(round, nowMs)) return null;
  const minutes = Math.ceil((Date.parse(round.awaitDeadline) - nowMs) / 60000);
  return minutes + 'm left';
}

// The hover title explaining the countdown (AC 6) -- one string, shared by the
// page-board pill and the ordinary send bar, so the two surfaces can never say
// something different about the same figure.
export const ROUND_COUNTDOWN_TITLE = "Time left before this round's wait ends";

// The page board pill's own fallback title (ADR.md entries 46, 40) -- read by
// src/render.mjs for the deterministic (never-awaited) case and by this file's
// own pageBoardPillMeta for every other closed case, so the two routes to the
// same word never explain it two different ways. True on a page board
// specifically: entries 45/46 turn its WHOLE compose/send surface off the
// moment it stops being awaited, so "commenting is off" is not an
// exaggeration there -- src/styles.mjs hides that board type's ordinary
// '.send-bar' outright, leaving nothing else to send with.
export const PILL_READONLY_TITLE = 'No agent is listening on this page -- commenting is off.';

// The SAME 'read-only' word's title on an ORDINARY board (SPEC_HEADER.md
// ticket 01, PM follow-up after ticket 03 put the state label there too,
// src/styles.mjs:464): PILL_READONLY_TITLE's "commenting is off" is simply
// false on that surface. `roundIsAwaited` (CONTEXT.md "Awaited") is about
// whether an `ask` call is still blocked waiting on this exact round -- a
// plain `ask` with no `wait: true` is never awaited, but its round is `open`
// the whole time, its ordinary send bar stays enabled throughout
// (src/ui.mjs's setSendBarEnabled reads `openRoundNumber`/`status`, never
// `awaited`), and a comment left there is drained to whichever agent asks
// next exactly like any other undelivered one (`drainUndeliveredComments`,
// src/server.mjs). The PM's call (not a defect to re-litigate): keep the
// visible word `read-only` exactly as AC 13 prescribes -- it is pinned there
// on purpose -- and fix only the claim underneath it that was actually false.
export const ROUND_OPEN_UNAWAITED_TITLE =
  'No agent is waiting live right now -- comments and answers here are saved and reach the next agent that asks.';

// What the page board's own Send control says once its round's wait has died
// under the reviewer (AC 12). The control freezes rather than vanishing, and it
// carries this instead of "Send": the reviewer's queued comments were flushed to
// the board on their way into the freeze (src/ui.mjs's refreshAwaitDisplay), so
// they are stored, and the drain (drainUndeliveredComments, src/server.mjs)
// hands them to the next agent that asks -- which is a promise worth making in
// the one place the reviewer is already looking. A frozen control that just
// disappeared said nothing, and the reviewer had no way to tell a comment that
// was safe from one that was lost.
export const PAGE_SEND_EXPIRED_LABEL = 'Goes out with the next round';
export const PAGE_SEND_EXPIRED_TITLE =
  'This round ended. Comments left here are stored and reach the next agent that asks.';

// The header's own pill/meta slot (ADR.md entry 40, "the pill may hold a
// label alone"; SPEC_HEADER.md ticket 03 widened it from a page-board-only
// slot to every board's): the countdown while someone is actually waiting, or
// the bare word `read-only` the moment nobody is -- never awaited at all
// (AC 8), sent, timed out, or archived (AC 11's fallback). Client-only (see
// this section's header comment); src/render.mjs's own first-paint fallback
// is `read-only` only, computed straight from `roundIsAwaitedOpen` with no
// clock at all -- the live figure is filled in at hydrate, before the reader
// can act on it.
//
// `fullpage` (default `true`, matching every caller before this parameter
// existed -- src/render.mjs's own page-board-era callers, and this file's own
// original name) is what tells the `read-only` case which of the two titles
// above is true for the round it is about (PILL_READONLY_TITLE stays the
// default rather than requiring every existing call site to opt back into
// it): a page board's `status` never leaves `open` even once its wait dies
// (ADR.md entry 44, "a page board is never sent"), so `round.status` alone
// cannot tell the two surfaces apart -- only the caller, which already knows
// whether it is rendering a page board or an ordinary one, can.
export function pageBoardPillMeta(round, nowMs, fullpage = true) {
  const countdown = roundCountdownText(round, nowMs);
  if (countdown) return { text: countdown, title: ROUND_COUNTDOWN_TITLE };
  const title = (!fullpage && round && round.status === 'open') ? ROUND_OPEN_UNAWAITED_TITLE : PILL_READONLY_TITLE;
  return { text: 'read-only', title };
}
