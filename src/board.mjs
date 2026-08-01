// The model: id minting, block normalisation, round bookkeeping, and packet
// assembly. See PROTOCOL.md "Board document", "Identifiers", "Packet".

import { createHash, randomBytes } from 'node:crypto';
import { mdToHtmlAndAnchors } from './markdown.mjs';
import { resolveRef, langForPath, resolveBoardCwd, MAX_REF_BYTES } from './resolve.mjs';
import { resolveAtRoot, sectionRootFrom, resolveMermaidAnchorAtRoot, htmlBodyRootFrom } from './anchor.mjs';
// Circular with render.mjs (which imports resolveComment from here): safe because
// neither module calls the other at module-evaluation time, only from inside a
// function body invoked later (renderBlock here, resolveComment there) — see
// resolveComment's own comment below for why resolving a page-scoped `dom` anchor
// needs to re-render the block it names.
import { renderBlock } from './render.mjs';

// Kind letter for block id minting (`q1`, `d3`, `m2`, ...): kind letter + ordinal
// within the board, stable once minted. `m` is reserved for mermaid per PROTOCOL's
// worked example, so markdown uses `d` (document) to avoid the collision. Added here
// additively since PROTOCOL only worked the question/mermaid examples.
export const KIND_LETTER = {
  question: 'q',
  markdown: 'd',
  mermaid: 'm',
  code: 'c',
  html: 'h',
  compare: 'x',
};

export const WIDGETS = ['single', 'multi', 'text', 'rank', 'choose-between-rendered-variants'];

function hex(n) {
  return randomBytes(n).toString('hex');
}

/** Board ids are 16 bytes, not 4 (audit 2026-07-28, M7). The width was forced when read
 * routes were open and the id was therefore the only thing gating `GET /b/:id`: at 4
 * bytes a local process could enumerate the space in seconds, at 16 it cannot. Reads are
 * gated now (SPEC_LAUNCH.md), so this is defence in depth rather than the whole defence,
 * and it stays that way — an id still travels in redirect targets and in whatever a
 * reviewer pastes into a chat. Thread ids stay short: a thread is a label in the index,
 * nothing is authorised by knowing one. */
export function mintBoardId() {
  return `b_${hex(16)}`;
}

export function mintThreadId() {
  return `th_${hex(4)}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Mint the next id for `kind`, mutating `counters` (a plain object of letter ->
 * count) so ids stay stable and ordinal within the board across normalisation
 * calls, including nested question context blocks. */
function nextBlockId(kind, counters) {
  const letter = KIND_LETTER[kind];
  if (!letter) throw new Error(`unknown block kind: ${kind}`);
  counters[letter] = (counters[letter] || 0) + 1;
  return `${letter}${counters[letter]}`;
}

// Every minted id matches this shape (kind letter + digits). A caller-supplied
// `raw.id` is only legitimate for the amendRound "replace this exact block"
// path (ticket 04); rejecting anything else here, at mint time, closes it as an
// injection vector everywhere an id later gets spliced into a DOM selector or
// used to look up a block (src/ui.mjs) rather than leaving each call site to
// re-derive the same guard.
const BLOCK_ID_RE = /^([a-z]+)(\d+)$/;

/** The uniqueness ledger one normalisation pass (one createBoard/addRound/amendRound
 * call) mints against. `taken` maps every id ALREADY on the board to the round it
 * belongs to; `replaceable` is the subset a caller-supplied id is allowed to name
 * (the top-level blocks of the round being amended, and nothing else); `minted`
 * accumulates the ids this pass has handed out, so two blocks in the same post can
 * never both claim one. `openRound` is only used to phrase the rejection. */
function emptyIdLedger() {
  return { taken: new Map(), replaceable: new Set(), minted: new Set(), openRound: null };
}

/** Resolve a block's id: the caller's `raw.id` when present, well-formed and
 * unclaimed (the amend "replace this exact block" path), else the next minted id
 * for `kind`.
 *
 * Throws on a malformed `raw.id` rather than minting around it or accepting it
 * verbatim -- a hand-crafted id is exactly the string that would otherwise reach
 * a CSS attribute selector unescaped in src/ui.mjs.
 *
 * Throws on a DUPLICATE `raw.id` too (audit H4), and raises `counters` to the
 * accepted ordinal so the next mint cannot land on it either. Both halves matter:
 * `board.answers` is keyed by block id, so two question blocks sharing an id
 * collapse to one answer entry and the packet reports the reviewer's answer to the
 * *first* question against the *second* question's prompt -- the agent is told,
 * confidently, something the reviewer never said. Ids are the board's only join
 * key; a duplicate is a wrong answer, not a cosmetic clash. */
function resolveBlockId(raw, kind, counters, ids) {
  if (raw.id != null) {
    const m = typeof raw.id === 'string' ? BLOCK_ID_RE.exec(raw.id) : null;
    if (!m) throw new Error(`invalid block id: ${JSON.stringify(raw.id)}`);
    // The id's kind letter must be THIS kind's letter (audit). `counters` is keyed
    // by kind letter while the ordinal is read off the id string, so accepting
    // `{ kind: 'markdown', id: 'q2' }` left the `q` counter untouched: a later
    // question then minted `q2`, collided with the markdown block, and replaced it
    // -- the markdown vanished from the board and every comment anchored to it
    // silently re-pointed at a question.
    if (m[1] !== KIND_LETTER[kind]) {
      throw new Error(`invalid block id: ${JSON.stringify(raw.id)} does not start with the '${KIND_LETTER[kind]}' letter a ${kind} block uses`);
    }
    const id = raw.id;
    if (ids.minted.has(id)) {
      throw new Error(`duplicate block id ${id}: two blocks in this post claim it`);
    }
    if (ids.taken.has(id) && !ids.replaceable.has(id)) {
      const owner = ids.taken.get(id);
      throw new Error(ids.openRound != null && owner !== ids.openRound
        ? `cannot amend: id ${id} belongs to round ${owner}, not the open round ${ids.openRound}`
        : `cannot amend: id ${id} is already taken by a block nested inside another block; only a top-level block can be replaced`);
    }
    ids.minted.add(id);
    // Keep the ordinal counter ahead of every accepted caller id, or the very next
    // mint for that kind letter re-issues this exact id.
    counters[m[1]] = Math.max(counters[m[1]] || 0, parseInt(m[2], 10));
    return id;
  }
  let id = nextBlockId(kind, counters);
  while (ids.taken.has(id) || ids.minted.has(id)) id = nextBlockId(kind, counters);
  ids.minted.add(id);
  return id;
}

/** Resolve a content block's text: by reference when `raw.source` is a Ref (read
 * once, sliced, sha'd — see src/resolve.mjs), by value from `raw.text` otherwise.
 * A resolve failure never throws: it comes back as `{ text: '', sha, error }` so the
 * block still gets minted and rendered, with the failure visible on it (see
 * PROTOCOL.md Blocks — additive `error` field), rather than the whole post failing
 * or the block silently vanishing. */
function resolveContent(raw, cwd) {
  if (raw.source) {
    const result = resolveRef(raw.source, { cwd });
    if (result.error) return { text: '', sha: sha256(''), error: result.error };
    return { text: result.text, sha: result.sha };
  }
  const text = byValueText(raw.text ?? '', 'text');
  return { text, sha: sha256(text) };
}

/** Bound a by-value `text`/`html` payload the same way src/resolve.mjs bounds a
 * file read. The stat/size cap there covers content read from disk; by-value
 * content arrives straight off the wire and gets fed to exactly the same
 * single-threaded, inline-on-the-request scanners (markdown block parsing,
 * src/anchor.mjs's html tree, and every re-render and packet build afterwards).
 * Loud (a 400 naming the field and the cap) rather than truncated: silently
 * dropping half a block's content would be a paraphrase, which is the one thing
 * content-by-reference exists to prevent. */
function byValueText(value, field) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_REF_BYTES) {
    throw new Error(`block ${field} is over the ${MAX_REF_BYTES}-byte cap; use a source reference instead`);
  }
  return text;
}

/** Normalise one content block (markdown/mermaid/code/html/compare) or question
 * block into its stored shape, minting an id and, for markdown, rendering html +
 * anchors. Content is resolved once here: by reference (`raw.source`, a Ref) through
 * src/resolve.mjs, or by value (`raw.text`) when there is no source — see
 * DESIGN.md "Questions by value, content by reference, snapshotted at post
 * time". `cwd` is the board's project directory, against which a relative Ref
 * resolves. `ids` is the pass's id ledger (see `emptyIdLedger`); it is threaded
 * through the recursion so a nested context/compare block competes for ids with
 * every other block in the same post, not just its siblings. */
export function normalizeBlock(raw, round, counters, cwd = null, ids = emptyIdLedger()) {
  if (!raw || typeof raw !== 'object' || !raw.kind) {
    throw new Error('block requires a kind');
  }
  const base = { round };
  switch (raw.kind) {
    case 'markdown': {
      const id = resolveBlockId(raw, 'markdown', counters, ids);
      const { text, sha, error } = resolveContent(raw, cwd);
      const { html, anchors } = mdToHtmlAndAnchors(text);
      return {
        ...base,
        id,
        kind: 'markdown',
        source: raw.source ?? null,
        text,
        sha,
        html,
        anchors,
        ...(error ? { error } : {}),
      };
    }
    case 'mermaid': {
      const id = resolveBlockId(raw, 'mermaid', counters, ids);
      const { text, sha, error } = resolveContent(raw, cwd);
      return {
        ...base,
        id,
        kind: 'mermaid',
        source: raw.source ?? null,
        text,
        sha,
        ...(error ? { error } : {}),
      };
    }
    case 'code': {
      const id = resolveBlockId(raw, 'code', counters, ids);
      const { text, sha, error } = resolveContent(raw, cwd);
      const lang = raw.lang ?? (raw.source ? langForPath(raw.source.path) : '');
      return {
        ...base,
        id,
        kind: 'code',
        source: raw.source ?? null,
        text,
        sha,
        lang,
        ...(error ? { error } : {}),
      };
    }
    case 'html': {
      const id = resolveBlockId(raw, 'html', counters, ids);
      return { ...base, id, kind: 'html', html: byValueText(raw.html ?? '', 'html') };
    }
    case 'compare': {
      const id = resolveBlockId(raw, 'compare', counters, ids);
      return {
        ...base,
        id,
        kind: 'compare',
        left: normalizeCompareSide(raw.left, round, counters, cwd, ids),
        right: normalizeCompareSide(raw.right, round, counters, cwd, ids),
      };
    }
    case 'question': {
      const id = resolveBlockId(raw, 'question', counters, ids);
      // An unrecognised widget is a rejection, not a silent fallback to 'single'
      // (audit L2). `{ widget: 'freetext' }` -- one word off the spec's 'text' --
      // used to render a question with no cards and no textarea: literally
      // unanswerable, and Send then reported it back as `unanswered`, so the agent
      // told the human's colleague "the reviewer left it blank" about a question
      // they were never given a control for. Same reasoning for a choice widget
      // with zero options. A 400 naming the widget is recoverable; a silently
      // unanswerable question is not.
      if (raw.widget != null && !WIDGETS.includes(raw.widget)) {
        throw new Error(`unknown widget: ${JSON.stringify(raw.widget)} (expected one of ${WIDGETS.join(', ')})`);
      }
      const widget = raw.widget ?? 'single';
      const context = Array.isArray(raw.context)
        ? raw.context.map(c => normalizeBlock(c, round, counters, cwd, ids))
        : [];
      // choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2) is the one widget whose
      // options are not a { preview } string: each option's `block` is a real
      // content block, normalized the SAME way normalizeCompareSide (below)
      // normalizes a compare side's own `block` -- same normalizeBlock/
      // resolveBlockId path, same shared `ids` ledger threaded through, so an
      // option's block mints a real, unique id and competes for ids with
      // every other block in the same post (findBlock/questionBlocks/
      // countersFromBoard/idLedgerFromBoard all walk `options[].block` below,
      // the same way they already walk a compare side's `block`). Null-
      // tolerant like a compare side, not required -- renderVariantOption
      // (src/render.mjs) shows the same "no content" fallback a compare side
      // with no block does. Every other widget keeps the old string-preview
      // shape unchanged.
      const options = Array.isArray(raw.options)
        ? raw.options.map(o => widget === 'choose-between-rendered-variants'
          ? { label: o.label, description: o.description ?? '', block: o.block ? normalizeBlock(o.block, round, counters, cwd, ids) : null }
          : { label: o.label, description: o.description ?? '', preview: o.preview ?? null })
        : [];
      if (widget !== 'text' && options.length === 0) {
        throw new Error(`question widget '${widget}' requires at least one option`);
      }
      return {
        ...base,
        id,
        kind: 'question',
        prompt: raw.prompt ?? '',
        context,
        widget,
        options,
      };
    }
    default:
      throw new Error(`unknown block kind: ${raw.kind}`);
  }
}

function normalizeCompareSide(side, round, counters, cwd, ids) {
  if (!side) return { label: '', block: null };
  return {
    label: side.label ?? '',
    block: side.block ? normalizeBlock(side.block, round, counters, cwd, ids) : null,
  };
}

/** Count existing kind-letter ids already present on the board so a follow-up round
 * mints ids that continue the sequence rather than restarting it. */
function countersFromBoard(board) {
  const counters = {};
  const visit = blk => {
    const letter = KIND_LETTER[blk.kind];
    if (letter) {
      const m = /^[a-z]+(\d+)$/.exec(blk.id);
      const n = m ? parseInt(m[1], 10) : 0;
      counters[letter] = Math.max(counters[letter] || 0, n);
    }
    if (blk.kind === 'question') {
      (blk.context || []).forEach(visit);
      // choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2): an option's nested block
      // mints an id too, and has to keep the same kind-letter counter ahead of
      // it as a context block or a compare side's block already does -- see
      // this widget's own comment in normalizeBlock above.
      (blk.options || []).forEach(o => { if (o.block) visit(o.block); });
    }
    if (blk.kind === 'compare') {
      if (blk.left?.block) visit(blk.left.block);
      if (blk.right?.block) visit(blk.right.block);
    }
  };
  for (const b of board.blocks) visit(b);
  return counters;
}

/** Build the id ledger for a pass over an existing board: every id anywhere on the
 * board (top-level, nested in a question's context, nested in a compare side) mapped
 * to the round it belongs to, plus the set a caller-supplied id may legitimately
 * replace. That set is deliberately only the TOP-LEVEL blocks of `replaceRound`,
 * because replacement itself only ever happens at top level (`amendRound` splices
 * `board.blocks`) -- letting a nested id through would append a second block with an
 * existing id rather than replace anything. `replaceRound: null` (addRound) makes
 * every existing id untouchable. */
function idLedgerFromBoard(board, replaceRound = null) {
  const ledger = emptyIdLedger();
  ledger.openRound = replaceRound;
  const visit = blk => {
    if (!blk) return;
    ledger.taken.set(blk.id, blk.round);
    if (blk.kind === 'question') {
      (blk.context || []).forEach(visit);
      // choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2): without this, an option's
      // nested block id would be absent from `ledger.taken` and a subsequent
      // addRound/amendRound could mint a duplicate against it -- exactly the
      // silent-id-collision failure mode resolveBlockId's own comment warns
      // about, just reached through a path this function used to miss.
      (blk.options || []).forEach(o => visit(o.block));
    }
    if (blk.kind === 'compare') {
      visit(blk.left?.block);
      visit(blk.right?.block);
    }
  };
  for (const b of board.blocks) {
    visit(b);
    if (replaceRound != null && b.round === replaceRound) ledger.replaceable.add(b.id);
  }
  return ledger;
}

/** Bind a board's project directory, once.
 *
 * `cwd` is the root every content reference is confined to (src/resolve.mjs), so it is
 * the single value that decides what a board can read. It is bound HERE, at thread
 * creation, and nowhere else: `addRound`/`amendRound` refuse a `cwd` outright, so a
 * later post cannot silently retarget a board the reviewer already has open. When the
 * caller names an existing thread, `threadCwd` is that thread's already-bound directory
 * and the request may only agree with it, never move it.
 *
 * Be precise about what this achieves, because the shape of the remaining hole matters
 * (audit C2, second half). It makes the read AUDITABLE (the board records the canonical
 * directory its content came from), STABLE (a live board cannot be retargeted mid-thread
 * — the case where a reviewer approves a diff and a later round quietly re-points the
 * same board at something else), and BOUNDED (`/` and `$HOME` are refused, so the blast
 * radius of a bad value is one project rather than the disk). It does NOT make the
 * choice unforgeable: any local process that can reach the loopback port can still POST
 * a NEW board naming a `cwd` it picked and read that directory back off the served page.
 * Closing that step needs the daemon to distinguish the session's own shim from any
 * other local caller, i.e. a credential the shim holds — which DESIGN.md's "no
 * tokens, no login" currently forbids. That is a spec question, deliberately not
 * answered here with an invented token. */
function bindBoardCwd(requested, threadCwd) {
  const resolved = resolveBoardCwd(requested);
  if (resolved.error) throw new Error(resolved.error);
  if (threadCwd == null) return resolved.path;
  if (resolved.path != null && resolved.path !== threadCwd) {
    throw new Error(`cannot retarget thread: its project directory is bound to ${threadCwd}, not ${resolved.path}`);
  }
  return threadCwd;
}

/** A round pushed into a LIVE board may not carry a `cwd` at all. The board's project
 * directory is bound once, at thread creation; a later round that could move it would
 * mean the reviewer's open tab silently starts reading somewhere else between rounds,
 * with the earlier rounds still on screen vouching for the board. Refused loudly (a
 * 400) rather than ignored quietly, so a caller that thinks it is setting `cwd` finds
 * out that it is not. Passing the SAME value the board already has is accepted -- that
 * is agreement, not a retarget. */
function assertCwdNotRetargeted(cwd, board) {
  if (cwd === undefined || cwd === null) return;
  const resolved = resolveBoardCwd(cwd);
  if (resolved.error) throw new Error(resolved.error);
  if (resolved.path !== board.cwd) {
    throw new Error(`cannot change the project directory of a live board: it is bound to ${board.cwd ?? '(none)'}`);
  }
}

/** Create a new board (round 1) from posted args: `{ title, blocks, cwd, thread }`.
 * `threadCwd` (additive) is the project directory already bound to `thread`, when the
 * caller is starting a second board in a thread that exists; the request may agree with
 * it but never change it. */
export function createBoard({ title, blocks, cwd = null, thread = null, threadCwd = null }) {
  const now = new Date().toISOString();
  const boundCwd = bindBoardCwd(cwd, threadCwd);
  const counters = {};
  const ids = emptyIdLedger();
  const normalized = (blocks || []).map(b => normalizeBlock(b, 1, counters, boundCwd, ids));
  return {
    id: mintBoardId(),
    thread: thread || mintThreadId(),
    title: title || '',
    cwd: boundCwd,
    createdAt: now,
    updatedAt: now,
    state: 'open',
    // `title` is stored on the round as well as on the board: every later round
    // carries its own (see addRound), and round 1's would otherwise be the only one
    // the history rail could not label.
    rounds: [{ n: 1, postedAt: now, status: 'open', sentAt: null, title: title || '' }],
    blocks: normalized,
    answers: {},
    comments: [],
  };
}

/** Append a new round of blocks into an existing (live) board. Returns the new round
 * number. Mutates `board` in place; caller persists it.
 *
 * A caller-supplied id that already exists anywhere on the board is rejected here
 * exactly as `amendRound` rejects a cross-round one (audit H4): a new round can only
 * ever ADD blocks, so an incoming id naming an existing block is either a mistake or
 * a Send racing an amend, and appending a second block under that id would silently
 * destroy the original round's answer (`board.answers` is keyed by id) and its
 * history-rail entry. Nothing on the board is mutated before the throw. */
export function addRound(board, { blocks, cwd, title }) {
  assertCwdNotRetargeted(cwd, board);
  const now = new Date().toISOString();
  const n = board.rounds.length + 1;
  const counters = countersFromBoard(board);
  const ids = idLedgerFromBoard(board, null);
  ids.openRound = n;
  const normalized = (blocks || []).map(b => normalizeBlock(b, n, counters, board.cwd, ids));
  // Per-round title, stored rather than dropped. `ask` requires a non-empty title on
  // every call and commands/grill.md tells the agent to make it the branch name, so a
  // thread that ran five rounds across five branches used to render five identical
  // "Round N" headings with the FIRST round's title as the only label on the page.
  // Falls back to the board title so a caller that omits it still gets a labelled
  // round rather than a bare number.
  board.rounds.push({ n, postedAt: now, status: 'open', sentAt: null, title: title || board.title || '' });
  board.blocks.push(...normalized);
  board.state = 'open';
  board.updatedAt = now;
  return n;
}

/** Push blocks into the round that is CURRENTLY OPEN without minting a new round
 * number: a block whose incoming raw carries an id already on the board replaces
 * that block in place, everything else is appended to the same round. See
 * DESIGN.md Decisions -> "A board is a session-scoped thread with rounds"
 * ("the agent may amend a round that is still open... without disturbing
 * filled-in fields") and ticket 04. Returns the round number amended and the ids
 * of exactly the blocks this call added or replaced -- not the round's full
 * history -- so the caller (src/server.mjs) can push only that delta over SSE
 * rather than re-sending blocks the reviewer has already seen and may be mid-edit
 * on. Mutates `board` in place; caller persists it. Throws if no round is open
 * (use `addRound` instead once the open round has been sent). */
export function amendRound(board, { blocks, cwd, title }) {
  assertCwdNotRetargeted(cwd, board);
  const openRound = board.rounds.find(r => r.status === 'open');
  if (!openRound) throw new Error('no open round to amend');
  const counters = countersFromBoard(board);
  // The id ledger decides, during normalisation and before anything is mutated,
  // which caller-supplied ids may be accepted: only the open round's top-level
  // blocks. An id naming a block minted in a DIFFERENT round -- almost always an
  // already-sent one -- is rejected there. Silently "replacing" it would move a
  // sent answer into the open round, re-enable its (now disabled) controls, and
  // leave the history rail for its real round rendering as if the question had
  // never been asked. That is not an amend, it is corruption of a round that
  // already went out.
  const ids = idLedgerFromBoard(board, openRound.n);
  const normalized = (blocks || []).map(b => normalizeBlock(b, openRound.n, counters, board.cwd, ids));
  const blockIds = [];
  for (const nb of normalized) {
    const idx = board.blocks.findIndex(b => b.id === nb.id);
    blockIds.push(nb.id);
    if (idx !== -1) board.blocks[idx] = nb; else board.blocks.push(nb);
  }
  // Applied here, after normalisation: everything above can still throw (an id
  // belonging to an already-sent round), and this function's contract is that a
  // rejected amend leaves the board exactly as it was. An amend that names no title
  // leaves the existing one alone rather than blanking a label the reviewer is
  // already looking at.
  if (title) openRound.title = title;
  board.updatedAt = new Date().toISOString();
  return { round: openRound.n, blockIds };
}

/** Find a block by id anywhere in the tree: top-level, or nested arbitrarily deep
 * inside a question's `context` or a compare block's `left`/`right` sides — both
 * of which can themselves hold another question/compare/etc (normalizeBlock
 * recurses when minting, so a compare nested inside a question's context, or a
 * compare-inside-compare, is a structurally valid board; findBlock has to be able
 * to reach it too, or a comment anchored to an element inside one always reports
 * lost even though it's live — see DESIGN.md's board slice 06 log). */
export function findBlock(board, blockId) {
  const search = b => {
    if (!b) return null;
    if (b.id === blockId) return b;
    if (b.kind === 'question') {
      for (const c of b.context || []) {
        const hit = search(c);
        if (hit) return hit;
      }
      // choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2): an option's nested block
      // is exactly as findable as a context block above -- a comment can
      // anchor to it (renderVariantOption, src/render.mjs, renders it through
      // the same renderBlock dispatch a context block or a compare side's
      // block already gets), so it has to resolve here too.
      for (const o of b.options || []) {
        const hit = search(o.block);
        if (hit) return hit;
      }
    }
    if (b.kind === 'compare') {
      const hit = search(b.left?.block) || search(b.right?.block);
      if (hit) return hit;
    }
    return null;
  };
  for (const b of board.blocks) {
    const hit = search(b);
    if (hit) return hit;
  }
  return null;
}

/** Every question block on the board, in display order, INCLUDING those nested in a
 * question's `context` array or a compare block's sides.
 *
 * `findBlock` above already recurses through exactly these nestings, and
 * src/render.mjs renders a nested question as a fully live widget that src/ui.mjs
 * collects on Send — but the packet and the unanswered synthesis used to walk
 * top-level `board.blocks` only (audit). The reviewer answered the question, the
 * answer was persisted to `board.answers`, and the agent was never told: for a tool
 * whose whole job is carrying answers back, a silently dropped answer is the worst
 * thing it can do. One traversal, used by everything that asks "which questions are
 * on this board". */
export function questionBlocks(board) {
  const out = [];
  const visit = b => {
    if (!b) return;
    if (b.kind === 'question') {
      out.push(b);
      (b.context || []).forEach(visit);
      // choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2): an option's own block can
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

// Every shape a stored `anchor` is allowed to take (PROTOCOL.md "Answers,
// comments, anchors"). Anything else degrades to a whole-block comment rather
// than being stored verbatim -- see sanitizeAnchor below (audit V3).
const ANCHOR_KINDS = new Set(['block', 'md', 'dom', 'mermaid']);

/** Reduce an untrusted, client-supplied `anchor` to one of the shapes
 * src/anchor.mjs actually knows how to resolve, dropping anything else rather
 * than persisting it verbatim (audit V3: `applySubmit` used to store `anchor`
 * exactly as posted, with no kind/shape check at all -- a forged
 * `{kind:'dom', ref:'1', hint:'...'}` was indistinguishable from a real one,
 * and a non-string `ref`/`hint` would have made every later `String(...)`
 * coercion downstream paper over garbage instead of the submit being rejected
 * at the door). An unrecognised `kind`, or a `dom`/`md`/`mermaid` anchor
 * missing the one field every resolver requires (`ref`), degrades to a plain
 * `{ kind: 'block' }` -- always resolvable, same fallback `applySubmit`
 * already used for a wholly absent anchor. */
function sanitizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return { kind: 'block' };
  const kind = ANCHOR_KINDS.has(anchor.kind) ? anchor.kind : 'block';
  if (kind === 'block') return { kind: 'block' };
  if (typeof anchor.ref !== 'string' || !anchor.ref) return { kind: 'block' };
  const out = { kind, ref: anchor.ref };
  if (kind === 'md') {
    if (typeof anchor.label === 'string') out.label = anchor.label;
    return out;
  }
  if (typeof anchor.hint === 'string') out.hint = anchor.hint;
  if (kind === 'mermaid' && typeof anchor.domRef === 'string') out.domRef = anchor.domRef;
  return out;
}

/** Apply a submit request to the board in place: merge answers (synthesising an
 * explicit `unanswered` entry for every question block never answered), append
 * comments, mark the round sent, and set board.state. Returns nothing; caller
 * persists `board`.
 *
 * An answer is only merged if its id names a question block OF THE ROUND BEING
 * SUBMITTED (audit C3). The submit body is untrusted: a forged POST could otherwise
 * write `board.answers['ghost9']`, and `buildPacket` hands the agent whatever
 * `board.answers` holds. Answers for a question the reviewer was never shown, for a
 * markdown block, or for an already-sent round's question (which would rewrite a
 * settled answer from a later round's Send) are all dropped silently rather than
 * stored -- there is nothing for the reviewer to fix, and a request that carries one
 * is not a request the human made. */
/** The closed set of answer statuses, and the only way one enters the store.
 *
 * `status` carries the whole decision on its own: PROTOCOL.md pins that a caller reads
 * it and never infers from `choice`, because a `deferred` answer may well have a choice
 * the reviewer picked and then declined to commit to. A field that load-bearing cannot
 * also be a free-text passthrough — an unrecognised value used to round-trip verbatim
 * into the packet, so `{status: 'answered', choice: null}` from a stale tab or a script
 * reported a decision the reviewer never made (audit 2026-07-31 D4). Anything outside
 * the set falls back to the same inference used when `status` is absent entirely, which
 * is the conservative reading rather than a silent accept. */
const ANSWER_STATUSES = new Set(['answered', 'unanswered', 'deferred']);

function normalizeStatus(a) {
  if (typeof a.status === 'string' && ANSWER_STATUSES.has(a.status)) return a.status;
  return a.choice != null ? 'answered' : 'unanswered';
}

export function applySubmit(board, { action, answers, comments }, round) {
  const now = new Date().toISOString();

  const allQuestions = questionBlocks(board);
  const answerable = new Set(allQuestions.filter(b => b.round === round).map(b => b.id));

  for (const a of answers || []) {
    if (!a || !a.id) continue;
    if (!answerable.has(a.id)) continue;
    board.answers[a.id] = {
      id: a.id,
      status: normalizeStatus(a),
      choice: a.choice ?? null,
      note: a.note ?? '',
    };
  }

  // unanswered is explicit, never a default silently dropped: every question block
  // on the board gets an answer entry IN THE STORED JSON, even if the reviewer never
  // touched it -- nested questions included. The archive is what criteria 4 and 14
  // rest on, and it has to be able to distinguish "the reviewer left this blank"
  // from "this round was never submitted"; buildPacket's own fallback cannot, since
  // it invents the same shape for a board that was never sent at all.
  for (const b of allQuestions) {
    if (!board.answers[b.id]) {
      board.answers[b.id] = { id: b.id, status: 'unanswered', choice: null, note: '' };
    }
  }

  for (const c of comments || []) {
    if (!c || !c.text) continue;
    // A comment naming no real block is never a request the reviewer made
    // (audit V3) -- same reasoning as the answer-merge guard above, and the
    // same lookup resolveComment will need at packet-assembly time anyway.
    const targetBlock = c.blockId ? findBlock(board, c.blockId) : null;
    if (!targetBlock) continue;
    const n = board.comments.length + 1;
    board.comments.push({
      n,
      blockId: c.blockId,
      anchor: sanitizeAnchor(c.anchor),
      text: c.text,
      createdAt: now,
      round,
      // The block's OWN kind at the moment this anchor was minted (audit U5):
      // resolveComment's `dom` branch picks resolveDomAnchor vs.
      // resolveDomAnchorInSection by the block's CURRENT kind, which is only
      // safe as long as the kind hasn't drifted since mint time. `amendRound`
      // can replace a block in place at the same id with a different kind, at
      // which point a stale iframe-relative `dom` ref would otherwise get
      // resolved against the new, differently-shaped section and could
      // coincidentally match. Recorded once, here, rather than re-derived,
      // since mint time is the only moment "what kind was this anchor minted
      // against" is actually known.
      mintBlockKind: targetBlock.kind,
    });
  }

  const r = board.rounds.find(r => r.n === round);
  if (r) {
    r.status = 'sent';
    r.sentAt = now;
  }
  board.state = action === 'discuss' ? 'discuss' : 'submitted';
  board.updatedAt = now;
}

// resolveComment's page-scoped `dom` branch (below) needs to re-render the exact
// block the anchor names, purely to walk its structure — never to show its own
// comment thread, which would make resolution depend on how many comments the
// block already has. An empty, shared map is enough: renderBlock's own content
// (everything resolveDomAnchorInSection walks) never depends on commentsByBlock,
// only its trailing comment-area markup does — see src/render.mjs's per-block
// renderers, where the comment area is always the LAST children of the section,
// after its own fixed-shape kicker/content/pin-layer, so a differing comment count
// there can never shift the index of anything resolveDomAnchorInSection resolves
// against. Module-level so every resolveComment call reuses the same empty Map
// rather than allocating one per comment.
const NO_COMMENTS = new Map();

/** The human-readable label a lost anchor reports: the stored hint when the anchor
 * carries one (a `dom` anchor's `hint`, e.g. "Send button in After stage" — see
 * DESIGN.md's ticket 04, "what it was about... is what survives when the
 * element does not"), else the ref (an `md`/`mermaid` anchor's ref is already a
 * human-legible slug/node-id), else `fallback`. Never undefined, so a malformed or
 * hand-edited anchor still names *something*. */
function lostLabel(anchor, fallback) {
  return anchor?.hint || anchor?.ref || fallback;
}

// Ticket 11, audit V4: resolveComment's `dom` (non-html) and `mermaid` branches
// both re-render the anchored block (renderBlock) and re-parse the result
// (parseHtmlTree, inside resolveDomAnchorInSection/resolveMermaidAnchor) to walk
// its structure. Every OTHER call site resolves every comment on the board in one
// pass -- renderBoardPage, resolveBoardComments (src/server.mjs, every SSE push
// and every archive write) and buildPacket below -- and every comment anchored to
// the SAME block resolves against the exact same rendered section, since nothing
// about a block changes between two comments in one pass. Measured before this
// cache existed: a 3.3 MB markdown block, 0 comments -> 5ms; 300 comments ->
// 2186ms, entirely re-render + re-parse work repeated 300 times over unchanging
// content. `blockCache` makes that render+parse happen at most once per block per
// pass: keyed by block id, holding whichever of the two roots below a comment on
// that block turns out to need, computed lazily (a board with only html-stage
// `dom` anchors never needs `sectionRoot` at all, and vice versa).
function sectionRootForBlock(blockCache, block, board) {
  let entry = blockCache.get(block.id);
  if (!entry) { entry = {}; blockCache.set(block.id, entry); }
  if (!('sectionRoot' in entry)) {
    entry.sectionRoot = sectionRootFrom(renderBlock(block, board, NO_COMMENTS, false));
  }
  return entry.sectionRoot;
}

function stageRootForBlock(blockCache, block) {
  let entry = blockCache.get(block.id);
  if (!entry) { entry = {}; blockCache.set(block.id, entry); }
  if (!('stageRoot' in entry)) {
    // htmlBodyRootFrom (audit C2), not a bare parseHtmlTree: the cache exists
    // to parse/hoist once per block per pass, so it is exactly the place a
    // cached-but-unhoisted root would silently undo C2's fix for every
    // comment after the first on the same html-stage block.
    entry.stageRoot = htmlBodyRootFrom(block.html);
  }
  return entry.stageRoot;
}

/** Resolve one stored comment against the board's current blocks: a `md` anchor is
 * resolved if its ref still appears in the block's anchor list; a `dom` anchor
 * anchored to an html stage is resolved if its ref addresses an element in that
 * block's snapshotted markup whose own text contains the hint (src/anchor.mjs's
 * resolveDomAnchor — both ref and hint have to agree, not just the hint appearing
 * somewhere in the block); a `dom` anchor anchored to any other block kind (ticket
 * 04 — prose, a list item, a table cell, a code line, a question widget, one side
 * of a comparison) is resolved the same way against that block RE-RENDERED from
 * its own stored content (src/render.mjs's `renderBlock`, exported for exactly
 * this — resolveDomAnchorInSection walks it the way resolveDomAnchor walks an html
 * stage's snapshot, rooted at the block's own section rather than a synthetic
 * document root, and checks the resolved element's identity rather than the full
 * "identity in context" hint — see that function's own comment for why); a
 * `mermaid` anchor (ticket 05 — a diagram node folds into the same generic model,
 * src/anchor.mjs's "ticket 05 design" comment has the full reasoning) is resolved
 * by resolveMermaidAnchor, which tries the SAME resolveDomAnchorInSection call
 * this branch already makes for every other block kind first, against `domRef`/
 * `hint`, and falls back to its node id (`ref`) still appearing in the mermaid
 * block's snapshotted diagram source only if that fails — a pre-ticket-05 anchor
 * (no `domRef`/`hint` stored) resolves exactly as before, since the generic
 * attempt returns false immediately for an absent ref; a `block` anchor is always
 * resolved (the block itself, if present). An anchor that no longer exists reports which anchor it lost
 * rather than vanishing (see PROTOCOL.md "Anchors at headings and list items" and
 * "Click-to-comment reaches individual elements" in DESIGN.md — the same
 * archived-board guarantee extends from markdown anchors to element-level ones).
 * `lost` always falls back to naming *something* (lostLabel above) rather than
 * coming back undefined, so a malformed/hand-edited anchor still names what it
 * lost instead of dropping the field.
 *
 * `blockCache` (ticket 11, audit V4) is optional and private to this module: every
 * external caller keeps calling `resolveComment(board, comment)` exactly as
 * before, unchanged signature, unchanged per-call cost. `resolveComments` below
 * is what actually passes one, shared across a whole board's worth of comments,
 * for the hot paths that resolve every comment on the board in one pass. */
export function resolveComment(board, comment, blockCache = new Map()) {
  const block = findBlock(board, comment.blockId);
  const out = {
    n: comment.n,
    blockId: comment.blockId,
    blockKind: block ? block.kind : null,
    anchor: comment.anchor,
    text: comment.text,
    // `round` and `createdAt` are carried through, not dropped (audit M4): without
    // them nothing downstream can tell a comment left this round from one settled
    // five rounds ago, which is how round 6's packet ended up re-delivering rounds
    // 1-5 as if they were fresh signal.
    round: comment.round ?? null,
    createdAt: comment.createdAt ?? null,
    resolved: true,
  };
  if (!block) {
    out.resolved = false;
    out.lost = lostLabel(comment.anchor, comment.blockId ?? '(unknown)');
    return out;
  }
  const anchorKind = comment.anchor?.kind;
  if (anchorKind === 'md') {
    const anchors = block.anchors || [];
    const found = anchors.some(a => a.ref === comment.anchor.ref);
    if (!found) {
      out.resolved = false;
      out.lost = lostLabel(comment.anchor, '(unknown)');
    }
  } else if (anchorKind === 'dom') {
    // Audit U5: `mintBlockKind` (applySubmit, above) is the block's own kind at
    // the moment this anchor was minted -- undefined for a comment stored
    // before this field existed, which resolves exactly as it always did
    // (backward compatible). When it IS known and no longer matches the
    // block's CURRENT kind, `amendRound` replaced this block in place with a
    // different kind (test/check-pure.mjs:340 constructs exactly that): the
    // stored ref was built against the OLD kind's root (an iframe body for
    // `html`, a page section for anything else) and has no business being
    // walked against the NEW one, even if the two trees happen to overlap
    // enough for some index to coincidentally resolve. Reported lost, the same
    // as any other anchor that no longer addresses what it once did -- never
    // attempted, unlike the plain html/non-html ternary below on its own,
    // mirroring the guard the `mermaid` branch already has (`block.kind ===
    // 'mermaid' &&`).
    const kindDrifted = comment.mintBlockKind != null && comment.mintBlockKind !== block.kind;
    // Audit U4 (routed here by the director, ticket 08's resolver-side half --
    // the client-side minting half is ticket 10's, which owns wireHtmlStage
    // and how in-stage anchors are minted): an 'html' block has TWO client-
    // side roots but this branch used to assume only one. `.html-stage` (the
    // iframe) is chrome (ANCHOR_CHROME_SELECTOR) and its OWN content is
    // reached only through wireHtmlStage's dedicated listener, which mints a
    // ref rooted at the iframe's `contentDocument.body` -- the common case,
    // tried first. But `.stage-wrap` (the div wrapping the iframe) is NOT
    // chrome, so a click on ITS own boundary (padding around the iframe,
    // never landing inside the sandboxed document) is caught by the generic
    // page-scoped listener instead, which mints a ref rooted at the block's
    // own SECTION via the same `anchorRootFor`/`buildSteps` path every other
    // block kind uses. One block kind, two client-side minting paths, so the
    // resolver tries both roots rather than assuming block kind alone decides
    // it -- same "generic first, more specific second" shape as
    // resolveMermaidAnchor's domRef-then-node-id fallback, not a new pattern.
    // ASSUMPTION FLAGGED FOR TICKET 10: this reconciles against today's
    // client-side minting (`anchorRootFor` finds the SECTION for anything
    // inside an html block that is not `.html-stage`/chrome). If ticket 10's
    // postMessage rewrite changes what root an in-stage click mints against,
    // this fallback needs to change to match, in the same direction.
    const found = !kindDrifted && (block.kind === 'html'
      ? resolveAtRoot(stageRootForBlock(blockCache, block), comment.anchor.ref, comment.anchor.hint)
        || resolveAtRoot(sectionRootForBlock(blockCache, block, board), comment.anchor.ref, comment.anchor.hint)
      : resolveAtRoot(sectionRootForBlock(blockCache, block, board), comment.anchor.ref, comment.anchor.hint));
    if (!found) {
      out.resolved = false;
      out.lost = lostLabel(comment.anchor, '(unknown)');
    }
  } else if (anchorKind === 'mermaid') {
    const found = block.kind === 'mermaid'
      && resolveMermaidAnchorAtRoot(sectionRootForBlock(blockCache, block, board), block.text, comment.anchor);
    if (!found) {
      out.resolved = false;
      out.lost = lostLabel(comment.anchor, '(unknown)');
    }
  }
  return out;
}

/** Resolve every one of `comments` against `board` in one pass, sharing a single
 * per-block render+parse cache across all of them (ticket 11, audit V4) — the
 * batch counterpart to calling `resolveComment` in a `.map`, which is what every
 * hot call site (`renderBoardPage`, `resolveBoardComments`, `buildPacket` below)
 * used to do and is now updated to call this instead. Behaviourally identical to
 * `comments.map(c => resolveComment(board, c))`: same per-comment result, same
 * order, just without re-rendering and re-parsing an unchanged block once per
 * comment anchored to it. */
export function resolveComments(board, comments) {
  const blockCache = new Map();
  return (comments || []).map(c => resolveComment(board, c, blockCache));
}

/** Assemble the packet the `ask` tool (eventually) returns, and what /wait resolves
 * with: names the board, the round, each question's status/choice/note, and every
 * comment with the anchor it attached to. See PROTOCOL.md "Packet".
 *
 * Scoped to `round` (audit M4): the packet answers the round that was just sent, not
 * the thread's whole history. It used to map every question block and every comment
 * ever stored, so round 6's packet redelivered rounds 1-5 -- the agent re-addressed
 * settled feedback and re-reported old `unanswered`/`deferred` entries as fresh
 * signal, each round louder than the last. Every entry additionally carries its own
 * `round` (PROTOCOL.md "Packet"), so a caller that genuinely wants the history can
 * read `board.answers`/`board.comments` and still tell the rounds apart. */
export function buildPacket(board, round, url) {
  const answers = questionBlocks(board)
    .filter(b => b.round === round)
    .map(b => {
      const a = board.answers[b.id] || { status: 'unanswered', choice: null, note: '' };
      return { id: b.id, round: b.round, prompt: b.prompt, widget: b.widget, status: a.status, choice: a.choice, note: a.note };
    });
  const comments = resolveComments(board, board.comments.filter(c => (c.round ?? round) === round));
  return {
    board: board.id,
    thread: board.thread,
    title: board.title,
    round,
    status: board.state,
    answers,
    comments,
    url,
  };
}
