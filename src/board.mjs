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
// needs to re-render the block it names. `highlightFenceHtml` is injected into
// markdown.mjs's mdToHtmlAndAnchors below rather than imported there directly, for
// the same reason: markdown.mjs is upstream of render.mjs through this exact
// circular edge, so a markdown.mjs -> render.mjs import would close a SECOND cycle
// (ADR.md entry 65, SPEC_RENDERING.md AC 14 "one renderer, not two").
import { renderBlock, highlightFenceHtml } from './render.mjs';
// badge.mjs is pure and imports nothing, so this edge is safe in both directions
// (render.mjs and ui.mjs also import it -- see its own header comment).
// `questionBlocks` itself moved to badge.mjs (ticket 04 of SPEC_AWAITED.md, so
// its "question block anywhere in the round" walk could be shared by
// roundIsAwaited's legacy fallback there too) and is re-exported below so every
// existing `from './board.mjs'` import keeps working unchanged.
import { isPageRound, questionBlocks } from './badge.mjs';
export { questionBlocks };

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

/** Board ids are 16 bytes, not 4: at 4 a local process enumerates the space in seconds.
 * Reads are gated now, so the width is defence in depth rather than the whole defence,
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
// path; rejecting anything else here, at mint time, closes it as an
// injection vector everywhere an id later gets spliced into a DOM selector or
// used to look up a block (src/ui.mjs) rather than leaving each call site to
// re-derive the same guard.
const BLOCK_ID_RE = /^([a-z]+)(\d+)$/;

/** Digits allowed in a block id's ordinal. Nine keeps every ordinal a safe integer
 * with room to spare; see resolveBlockId for what an unbounded one does to the mint
 * loop. No real board approaches four digits. */
const MAX_ID_ORDINAL_DIGITS = 9;

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
 * Throws on a DUPLICATE `raw.id` too, and raises `counters` to the accepted ordinal so
 * the next mint cannot land on it either. Ids are the board's only join key, and
 * `board.answers` is keyed by block id: two question blocks sharing one collapse to a
 * single answer entry, and the packet then reports the reviewer's answer to the *first*
 * question against the *second* question's prompt. A duplicate is a wrong answer, not a
 * cosmetic clash. */
function resolveBlockId(raw, kind, counters, ids, topLevel = true) {
  if (raw.id != null) {
    const m = typeof raw.id === 'string' ? BLOCK_ID_RE.exec(raw.id) : null;
    if (!m) throw new Error(`invalid block id: ${JSON.stringify(raw.id)}`);
    // The ordinal has to stay a safe integer. `BLOCK_ID_RE` accepts `\d+` of
    // any length, and past 2^53 `counters[letter] + 1` is a no-op -- `nextBlockId`
    // then returns the same string forever and the re-mint loop below never
    // terminates. A 21-digit ordinal also round-trips through `parseInt` as `1e+21`,
    // which is minted as a literal `q1e+21`: an id that fails BLOCK_ID_RE, is stored
    // anyway, and breaks every `querySelector` built from it.
    if (m[2].length > MAX_ID_ORDINAL_DIGITS) {
      throw new Error(`invalid block id: ${JSON.stringify(raw.id)} has an implausible ordinal`);
    }
    // The id's kind letter must be THIS kind's letter. `counters` is keyed
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
    // `replaceable` holds the open round's TOP-LEVEL ids, so only a top-level block
    // may claim one -- where the CLAIMING block sits matters as much as where the id's
    // existing owner sits. `amendRound` splices on top-level ids only, so a nested
    // claimant would be appended rather than substituted, leaving two live blocks
    // sharing one id and one `answers` entry answering both prompts.
    if (ids.taken.has(id) && !(topLevel && ids.replaceable.has(id))) {
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
    // `startLine` (1-based) rides along so a code block's gutter can show the file's
    // OWN line numbers for a `section:` slice too, not just a `lines:` range -- only
    // src/resolve.mjs knows where a named section actually starts. Carried as a
    // normalised block field rather than back onto `source`, because `source` is
    // stored verbatim from the request and a caller could forge it there.
    return { text: result.text, sha: result.sha, startLine: result.startLine };
  }
  const text = byValueText(raw.text ?? '', 'text');
  return { text, sha: sha256(text) };
}

/** Bound a by-value `text`/`html` payload the same way src/resolve.mjs bounds a file
 * read: its stat/size cap covers content read from disk, and by-value content arrives
 * straight off the wire into exactly the same single-threaded, inline-on-the-request
 * scanners (markdown block parsing, src/anchor.mjs's html tree, and every re-render and
 * packet build afterwards). Loud (a 400 naming the field and the cap) rather than
 * truncated: silently dropping half a block's content would be a paraphrase, the one
 * thing content-by-reference exists to prevent. */
function byValueText(value, field) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_REF_BYTES) {
    // Not "use a source reference instead": a reference
    // does not raise this cap for any kind. src/resolve.mjs's resolveRef checks the
    // whole file's size from fstat BEFORE any slicing, so a reference to content this
    // size is refused exactly as this by-value payload is -- there is no remedy here,
    // only a smaller payload.
    throw new Error(`block ${field} is over the ${MAX_REF_BYTES}-byte cap; a source reference to content this size would be refused the same way`);
  }
  return text;
}

/** Normalise one content block (markdown/mermaid/code/html/compare) or question
 * block into its stored shape, minting an id and, for markdown, rendering html +
 * anchors. Content is resolved once here: by reference (`raw.source`, a Ref) through
 * src/resolve.mjs, or by value (`raw.text`) when there is no source. `cwd` is the board's project directory, against which a relative Ref
 * resolves. `ids` is the pass's id ledger (see `emptyIdLedger`); it is threaded
 * through the recursion so a nested context/compare block competes for ids with
 * every other block in the same post, not just its siblings. */
export function normalizeBlock(raw, round, counters, cwd = null, ids = emptyIdLedger(), topLevel = true) {
  if (!raw || typeof raw !== 'object' || !raw.kind) {
    throw new Error('block requires a kind');
  }
  const base = { round };
  switch (raw.kind) {
    case 'markdown': {
      const id = resolveBlockId(raw, 'markdown', counters, ids, topLevel);
      const { text, sha, error } = resolveContent(raw, cwd);
      const { html, anchors } = mdToHtmlAndAnchors(text, { highlight: highlightFenceHtml });
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
      const id = resolveBlockId(raw, 'mermaid', counters, ids, topLevel);
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
      const id = resolveBlockId(raw, 'code', counters, ids, topLevel);
      const { text, sha, error, startLine } = resolveContent(raw, cwd);
      const lang = raw.lang ?? (raw.source ? langForPath(raw.source.path) : '');
      return {
        ...base,
        id,
        kind: 'code',
        source: raw.source ?? null,
        text,
        sha,
        lang,
        ...(Number.isInteger(startLine) ? { startLine } : {}),
        ...(error ? { error } : {}),
      };
    }
    case 'html': {
      const id = resolveBlockId(raw, 'html', counters, ids, topLevel);
      // Path-only: the other referenced kinds slice
      // because text stays text under a knife, but cutting markup at a line or a
      // section yields unclosed tags and orphaned <style>/<script> -- a broken stage,
      // not a smaller one. Refused as a block-level error, same shape every other
      // resolve failure takes (never thrown, block still minted and rendered with the
      // reason visible), rather than silently ignoring the parameter or slicing markup
      // that only breaks.
      if (raw.source && (raw.source.lines || raw.source.section)) {
        return {
          ...base,
          id,
          kind: 'html',
          source: raw.source,
          html: '',
          // sha of the empty string, not absent: PROTOCOL.md's resolve-failure contract
          // says a failed block is still minted with its content empty and its sha the
          // hash of that empty content. This refusal happens before resolveContent runs,
          // so it has to state the same shape by hand rather than inheriting it.
          sha: sha256(''),
          error: 'html source refuses lines/section: slicing markup yields unclosed tags and orphaned styles, not a valid fragment -- reference the whole file',
        };
      }
      if (raw.source) {
        // Routed through the exact same resolveContent -> resolveRef path every other
        // referenced kind uses: same confinement, same 512 KiB whole-file cap, same
        // sha snapshot, same never-throws error shape. `html` (not `text`) is the field
        // every consumer of an html block already reads (render.mjs's renderHtmlBlock,
        // src/anchor.mjs's htmlBodyRootFrom) -- renamed here so a referenced file
        // reaches the stage through the identical field a by-value mock always used.
        const { text, sha, error } = resolveContent(raw, cwd);
        return {
          ...base,
          id,
          kind: 'html',
          source: raw.source,
          html: text,
          sha,
          ...(error ? { error } : {}),
        };
      }
      // `source: null` and a sha even by value, exactly as markdown/mermaid/code do
      // through resolveContent: PROTOCOL.md's block table states one shape per kind,
      // not one per way the content arrived, and a consumer that reads `sha` off a
      // block should not have to know which branch minted it. This branch cannot just
      // call resolveContent, because that reads `raw.text` and an html block's
      // by-value field is `raw.html`.
      const html = byValueText(raw.html ?? '', 'html');
      return { ...base, id, kind: 'html', source: null, html, sha: sha256(html) };
    }
    case 'compare': {
      const id = resolveBlockId(raw, 'compare', counters, ids, topLevel);
      return {
        ...base,
        id,
        kind: 'compare',
        left: normalizeCompareSide(raw.left, round, counters, cwd, ids),
        right: normalizeCompareSide(raw.right, round, counters, cwd, ids),
      };
    }
    case 'question': {
      const id = resolveBlockId(raw, 'question', counters, ids, topLevel);
      // An unrecognised widget is a rejection, not a silent fallback to 'single': a
      // widget name one word off the spec ('freetext' for 'text') renders a question
      // with no cards and no textarea, which Send then reports back as `unanswered` --
      // the agent tells someone "the reviewer left it blank" about a question they were
      // never given a control for. Same reasoning for a choice widget with zero options.
      // A 400 naming the widget is recoverable; a silently unanswerable question is not.
      if (raw.widget != null && !WIDGETS.includes(raw.widget)) {
        throw new Error(`unknown widget: ${JSON.stringify(raw.widget)} (expected one of ${WIDGETS.join(', ')})`);
      }
      const widget = raw.widget ?? 'single';
      const context = Array.isArray(raw.context)
        ? raw.context.map(c => normalizeBlock(c, round, counters, cwd, ids, false))
        : [];
      // choose-between-rendered-variants is the one widget whose
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
      // `label`/`description`/`preview`/`prompt` go through byValueText for the same
      // reason `text` and `html` do: they were bounded only by the 25MB body
      // limit, and `preview` additionally feeds a URL sniff in src/render.mjs whose
      // cost is quadratic in its length -- a 400KB preview measured ~46s per render,
      // paid again on every read because the board persists first.
      const options = Array.isArray(raw.options)
        ? raw.options.map(o => widget === 'choose-between-rendered-variants'
          ? { label: byValueText(o.label ?? '', 'option label'), description: byValueText(o.description ?? '', 'option description'), block: o.block ? normalizeBlock(o.block, round, counters, cwd, ids, false) : null }
          : { label: byValueText(o.label ?? '', 'option label'), description: byValueText(o.description ?? '', 'option description'), preview: o.preview == null ? null : byValueText(o.preview, 'option preview') })
        : [];
      if (widget !== 'text' && options.length === 0) {
        throw new Error(`question widget '${widget}' requires at least one option`);
      }
      return {
        ...base,
        id,
        kind: 'question',
        prompt: byValueText(raw.prompt ?? '', 'prompt'),
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
    block: side.block ? normalizeBlock(side.block, round, counters, cwd, ids, false) : null,
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
      // choose-between-rendered-variants: an option's nested block
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
      // choose-between-rendered-variants: without this, an option's
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
 * What this achieves, and the shape of the hole it leaves. It makes the read AUDITABLE
 * (the board records the canonical directory its content came from), STABLE (a live
 * board cannot be retargeted mid-thread — a reviewer approves a diff, a later round
 * quietly re-points the same board elsewhere), and BOUNDED (`/` and `$HOME` are refused,
 * so a bad value costs one project rather than the disk). It does NOT make the choice
 * unforgeable: any local process reaching the loopback port can still POST a NEW board
 * naming a `cwd` it picked and read that directory back off the served page. Closing
 * that needs the daemon to tell the session's own shim from any other local caller, a
 * credential "no tokens, no login" currently forbids — a spec question, deliberately not
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

/** 40 minutes (ADR.md entry 47): the default a round's `awaitDeadline` is stamped
 * `awaitTimeoutMs` amount of time past `postedAt` with, when a caller (test or
 * otherwise) mints a round through this module without naming its own. The real
 * daemon path never relies on this default landing correctly on its own --
 * src/server.mjs's `handlePostBoard` always passes the env-resolved
 * `waitTimeoutMs()` explicitly, so `CLAUDE_BOARD_TIMEOUT_MS` governs both the
 * deadline stamped here and the wall-clock cap `/wait` actually enforces (one
 * clock, one env var). Exported so a check can assert this and
 * `DEFAULT_WAIT_TIMEOUT_MS` (src/server.mjs) stay equal rather than drifting. */
export const DEFAULT_AWAIT_TIMEOUT_MS = 2_400_000;

/** Whether a round being minted is *awaited* (CONTEXT.md), and the absolute instant
 * its wait dies if it is: `{ awaited, awaitDeadline }`. Two ways in, matching the
 * glossary exactly -- a round carrying a question always is (ADR.md entry 42's
 * question rounds always blocked, unchanged here), and a page board (one `html`
 * block, ADR.md entry 33) is only when the caller declared `wait: true` on this
 * call (ADR.md entry 45). Every other shape -- content-only, more than one block,
 * no question -- stays exactly what it is today: posted and never waited on,
 * `wait: true` or not, because CONTEXT.md's Awaited entry names only these two
 * routes in and this ticket does not invent a third.
 *
 * `wait: true` on a round that already asks something is IGNORED, not refused --
 * the `||` below is what implements that, and it is a decision, not a fallout.
 * Such a round is already awaited by construction, so the flag asks for the
 * state it is already in: there is nothing to refuse and nothing to add, and a
 * refusal would fail a call whose only sin is saying out loud what the round
 * already does. Pinned by test/check-page-board.mjs, on both call sites below,
 * deadline included.
 *
 * `blocks` here is THIS round's own normalized blocks only (never the whole
 * board's), which is what both callers below already have in hand and what makes
 * `isPageRound` and `questionBlocks({ blocks })` correct without a `round` filter. */
function mintAwait(blocks, round, wait, postedAt, awaitTimeoutMs) {
  const awaited = questionBlocks({ blocks }).some(q => q.round === round)
    || (Boolean(wait) && isPageRound(blocks));
  return {
    awaited,
    awaitDeadline: awaited ? new Date(Date.parse(postedAt) + awaitTimeoutMs).toISOString() : null,
  };
}

/** Create a new board (round 1) from posted args: `{ title, blocks, cwd, thread, wait }`.
 * `threadCwd` (additive) is the project directory already bound to `thread`, when the
 * caller is starting a second board in a thread that exists; the request may agree with
 * it but never change it. `wait` is round 1's own declared-awaited flag (ADR.md entry
 * 45); see `mintAwait` above for the two ways a round becomes awaited. */
export function createBoard({ title, blocks, cwd = null, thread = null, threadCwd = null, wait = false, awaitTimeoutMs = DEFAULT_AWAIT_TIMEOUT_MS }) {
  const now = new Date().toISOString();
  const boundCwd = bindBoardCwd(cwd, threadCwd);
  const counters = {};
  const ids = emptyIdLedger();
  const normalized = (blocks || []).map(b => normalizeBlock(b, 1, counters, boundCwd, ids));
  const { awaited, awaitDeadline } = mintAwait(normalized, 1, wait, now, awaitTimeoutMs);
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
    // the page label and the round pager could not name.
    rounds: [{ n: 1, postedAt: now, status: 'open', sentAt: null, title: title || '', awaited, awaitDeadline }],
    blocks: normalized,
    answers: {},
    comments: [],
  };
}

/** Append a new round of blocks into an existing (live) board. Returns the new round
 * number. Mutates `board` in place; caller persists it.
 *
 * A caller-supplied id that already exists anywhere on the board is rejected here
 * exactly as `amendRound` rejects a cross-round one: a new round can only
 * ever ADD blocks, so an incoming id naming an existing block is either a mistake or
 * a Send racing an amend, and appending a second block under that id would silently
 * destroy the original round's answer (`board.answers` is keyed by id) and its
 * history-rail entry. Nothing on the board is mutated before the throw. */
export function addRound(board, { blocks, cwd, title, wait = false, awaitTimeoutMs = DEFAULT_AWAIT_TIMEOUT_MS }) {
  assertCwdNotRetargeted(cwd, board);
  const now = new Date().toISOString();
  const n = board.rounds.length + 1;
  const counters = countersFromBoard(board);
  const ids = idLedgerFromBoard(board, null);
  ids.openRound = n;
  const normalized = (blocks || []).map(b => normalizeBlock(b, n, counters, board.cwd, ids));
  const { awaited, awaitDeadline } = mintAwait(normalized, n, wait, now, awaitTimeoutMs);
  // Per-round title, stored rather than dropped. `ask` requires a non-empty title on
  // every call and commands/grill.md tells the agent to make it the branch name, so a
  // thread that ran five rounds across five branches used to render five identical
  // "Round N" headings with the FIRST round's title as the only label on the page.
  // Falls back to the board title so a caller that omits it still gets a labelled
  // round rather than a bare number.
  board.rounds.push({ n, postedAt: now, status: 'open', sentAt: null, title: title || board.title || '', awaited, awaitDeadline });
  board.blocks.push(...normalized);
  board.state = 'open';
  board.updatedAt = now;
  return n;
}

/** Push blocks into the round that is CURRENTLY OPEN without minting a new round
 * number: a block whose incoming raw carries an id already on the board replaces
 * that block in place, everything else is appended to the same round. Returns the round number amended and the ids
 * of exactly the blocks this call added or replaced -- not the round's full
 * history -- so the caller (src/server.mjs) can push only that delta over SSE
 * rather than re-sending blocks the reviewer has already seen and may be mid-edit
 * on. Mutates `board` in place; caller persists it. Throws if no round is open
 * (use `addRound` instead once the open round has been sent). */
export function amendRound(board, { blocks, cwd, title }) {
  assertCwdNotRetargeted(cwd, board);
  // The LATEST open round, not the first one. A board can hold two open rounds
  // at once now: an artifact round is never sendable (ADR.md entry 35), so it
  // stays `open` for good, and the question round posted after it is open too.
  // `find` took the earliest, which is the artifact's -- so a later amend
  // normalised its blocks into the ARTIFACT's round, appending a question to the
  // page the reviewer is reading and never touching the round the caller meant.
  // "The round currently being assembled" has always meant the newest one; this
  // only stops the two readings diverging now that they can.
  const openRound = [...board.rounds].reverse().find(r => r.status === 'open');
  if (!openRound) throw new Error('no open round to amend');
  const counters = countersFromBoard(board);
  // The id ledger decides, during normalisation and before anything is mutated,
  // which caller-supplied ids may be accepted: only the open round's top-level
  // blocks. An id naming a block minted in a DIFFERENT round -- almost always an
  // already-sent one -- is rejected there. Silently "replacing" it would move a
  // sent answer into the open round, re-enable its (now disabled) controls, and
  // leave that block's own round -- a page the reviewer can still flip back to --
  // rendering as if the question had never been asked. That is not an amend, it is corruption of a round that
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

/** Close every round still open on `board`, because the conversation that was posting
 * to it declared a boundary and walked away (ADR 69). Returns the round numbers closed;
 * mutates `board` in place, caller persists it.
 *
 * `status: 'abandoned'` is a THIRD terminal state, and inventing one is the point. Until
 * now exactly two things ended an awaited round, and neither is honest here:
 *
 *  - `applySubmit` above marks it `sent` with an `action` of `'submitted'`/`'discuss'`.
 *    That records that a human answered. Nobody did — the reviewer walked away and the
 *    agent cleared its context — so a fabricated submit with an empty answer array would
 *    put a lie in the durable board document and surface it as an answered round in the
 *    index, the badge and the archive for good.
 *  - `closeLapsedAwaitedRounds` (src/badge.mjs) clears `awaited` and deliberately leaves
 *    `status: 'open'` forever. That is a lapse, not a close: the round would go on
 *    advertising itself as open on a board nothing will ever post to again.
 *
 * So the round is closed and labelled as neither: not answered, not lapsed, abandoned.
 * Every reader that asks "is this round open" already asks `status === 'open'`
 * (`roundIsAwaitedOpen` and `closeLapsedAwaitedRounds` in src/badge.mjs, `amendRound`
 * above, `handleSubmit` and the `requestId` dedupe in src/server.mjs,
 * `openAwaitedRounds` in src/indexpage.mjs, `hasOpenRound` in src/render.mjs), so all of
 * them drop an abandoned round with no code of their own — including the stranded rule,
 * which is the load-bearing one: a round nobody is listening for is exactly what its
 * Banner exists to announce, and `stillWaiting` must stop finding this one.
 *
 * `awaited: false` is set here rather than left for a clock, because the wait did not
 * lapse — it was abandoned, now. `awaitDeadline` is left exactly as minted, the same way
 * a lapse leaves it: it is the record of the wait this round was born with, and nothing
 * is served by rewriting history to claim the deadline fell earlier than it did.
 * `sentAt` stays null for the same reason; `abandonedAt` is the stamp beside it that says
 * when this actually happened, since `updatedAt` is board-wide and gets overwritten.
 *
 * No `action` is recorded. `action` is the reviewer's own choice and `buildPacket` reads
 * it straight into the packet's `status`, so writing one here would invent a packet
 * status no caller knows. */
export function abandonOpenRounds(board) {
  const now = new Date().toISOString();
  const closed = [];
  for (const r of (board && board.rounds) || []) {
    if (r.status !== 'open') continue;
    r.status = 'abandoned';
    r.abandonedAt = now;
    r.awaited = false;
    closed.push(r.n);
  }
  if (closed.length) board.updatedAt = now;
  return closed;
}

/** Find a block by id anywhere in the tree: top-level, or nested arbitrarily deep
 * inside a question's `context` or a compare block's `left`/`right` sides — both
 * of which can themselves hold another question/compare/etc (normalizeBlock
 * recurses when minting, so a compare nested inside a question's context, or a
 * compare-inside-compare, is a structurally valid board; findBlock has to be able
 * to reach it too, or a comment anchored to an element inside one always reports
 * lost even though it's live). */
export function findBlock(board, blockId) {
  const search = b => {
    if (!b) return null;
    if (b.id === blockId) return b;
    if (b.kind === 'question') {
      for (const c of b.context || []) {
        const hit = search(c);
        if (hit) return hit;
      }
      // choose-between-rendered-variants: an option's nested block
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

// Every shape a stored `anchor` is allowed to take (PROTOCOL.md "Answers,
// comments, anchors"). Anything else degrades to a whole-block comment rather
// than being stored verbatim -- see sanitizeAnchor below.
// ADR.md entry 28 deleted the `md` kind (a markdown heading or top-level list
// item) along with the affordance that minted it: only `html` and `mermaid` are
// commentable now, and neither ever produced one. A stored `md` anchor arriving
// from an older client degrades to a whole-block comment, the same as any other
// unrecognised kind.
const ANCHOR_KINDS = new Set(['block', 'dom', 'mermaid']);

/** Ceiling on every stored anchor string. `extractHint` caps a hint at 80 and
 * `composeHint` adds a short frame around it; a node id or a step chain is tens of
 * bytes. 1024 cannot truncate anything the client legitimately mints, and bounds the
 * quadratic scan in mermaidRefResolves. */
const MAX_ANCHOR_FIELD = 1024;

/** Reduce an untrusted, client-supplied `anchor` to one of the shapes
 * src/anchor.mjs actually knows how to resolve, dropping anything else rather
 * than persisting it verbatim. `applySubmit` used to store `anchor`
 * exactly as posted, with no kind/shape check at all -- a forged
 * `{kind:'dom', ref:'1', hint:'...'}` was indistinguishable from a real one,
 * and a non-string `ref`/`hint` would have made every later `String(...)`
 * coercion downstream paper over garbage instead of the submit being rejected
 * at the door. An unrecognised `kind`, or a `dom`/`mermaid` anchor
 * missing the one field every resolver requires (`ref`), degrades to a plain
 * `{ kind: 'block' }` -- always resolvable, same fallback `applySubmit`
 * already used for a wholly absent anchor. */
function sanitizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return { kind: 'block' };
  const kind = ANCHOR_KINDS.has(anchor.kind) ? anchor.kind : 'block';
  if (kind === 'block') return { kind: 'block' };
  if (typeof anchor.ref !== 'string' || !anchor.ref) return { kind: 'block' };
  // Length is part of the shape. Nothing bounded these, and
  // `mermaidRefResolves` costs (len(text) - len(ref)) * len(ref): one stored comment
  // carrying a 256KiB `ref` against a 512KiB mermaid block measured ~23s per
  // renderBoardPage, per SSE resolve and per buildPacket -- for the life of the
  // board, since comments are append-only and there is no in-product way to remove
  // one. A real node id, step chain or hint is tens of bytes.
  if (anchor.ref.length > MAX_ANCHOR_FIELD) return { kind: 'block' };
  const out = { kind, ref: anchor.ref };
  if (typeof anchor.hint === 'string') out.hint = anchor.hint.slice(0, MAX_ANCHOR_FIELD);
  // Dropped rather than truncated: a shortened step chain is still a WELL-FORMED
  // chain, so it would resolve confidently against the wrong element. Absent is
  // honest -- resolveMermaidAnchorAtRoot just falls through to the id scan.
  if (kind === 'mermaid' && typeof anchor.domRef === 'string' && anchor.domRef.length <= MAX_ANCHOR_FIELD) out.domRef = anchor.domRef;
  return out;
}

/** The closed set of answer statuses, and the only way one enters the store.
 *
 * `status` carries the whole decision on its own: PROTOCOL.md pins that a caller reads
 * it and never infers from `choice`, because a `deferred` answer may well have a choice
 * the reviewer picked and then declined to commit to. A field that load-bearing cannot
 * also be a free-text passthrough — an unrecognised value used to round-trip verbatim
 * into the packet, so `{status: 'answered', choice: null}` from a stale tab or a script
 * reported a decision the reviewer never made. Anything outside
 * the set falls back to the same inference used when `status` is absent entirely, which
 * is the conservative reading rather than a silent accept. */
const ANSWER_STATUSES = new Set(['answered', 'unanswered', 'deferred']);

function normalizeStatus(a) {
  if (typeof a.status === 'string' && ANSWER_STATUSES.has(a.status)) return a.status;
  return a.choice != null ? 'answered' : 'unanswered';
}

/** Apply a submit request to the board in place: merge answers (synthesising an
 * explicit `unanswered` entry for every question block never answered), append
 * comments, mark the round sent, and set board.state. Returns nothing; caller
 * persists `board`.
 *
 * An answer is only merged if its id names a question block OF THE ROUND BEING
 * SUBMITTED. The submit body is untrusted: a forged POST could otherwise
 * write `board.answers['ghost9']`, and `buildPacket` hands the agent whatever
 * `board.answers` holds. Answers for a question the reviewer was never shown, for a
 * markdown block, or for an already-sent round's question (which would rewrite a
 * settled answer from a later round's Send) are all dropped silently rather than
 * stored -- there is nothing for the reviewer to fix, and a request that carries one
 * is not a request the human made. */
export function applySubmit(board, { action, answers, comments }, round) {
  const now = new Date().toISOString();

  const allQuestions = questionBlocks(board);
  const answerable = new Set(allQuestions.filter(b => b.round === round).map(b => b.id));

  for (const a of answers || []) {
    if (!a || !a.id) continue;
    if (!answerable.has(a.id)) continue;
    // Coerce at the trust boundary, not at each read site. `note` and `choice` came
    // straight off the wire untyped, and one submit carrying `note: 12345` wedged
    // src/store.mjs's searchBoards -- which calls .toLowerCase() on it -- for the WHOLE
    // store, permanently: every archive search 500s, the healthy boards' hits included,
    // and the only repair in the product is a prune old enough to reach the poisoned
    // board -- which takes every board of that age with it (src/store.mjs pruneStore).
    board.answers[a.id] = {
      id: a.id,
      status: normalizeStatus(a),
      choice: Array.isArray(a.choice)
        ? a.choice.map(c => byValueText(c ?? '', 'answer choice'))
        : (a.choice == null ? null : byValueText(a.choice, 'answer choice')),
      note: byValueText(a.note ?? '', 'answer note'),
    };
  }

  // unanswered is explicit, never a default silently dropped: every question block
  // on the board gets an answer entry IN THE STORED JSON, even if the reviewer never
  // touched it -- nested questions included. The archive is what criteria 4 and 14
  // rest on, and it has to be able to distinguish "the reviewer left this blank"
  // from "this round was never submitted"; buildPacket's own fallback cannot, since
  // it invents the same shape for a board that was never sent at all.
  // Scoped to the round being submitted, like `answerable` above. Board-wide, this
  // loop backfilled `unanswered` entries for questions belonging to a round that is
  // still OPEN -- reachable now that two rounds can be open at once (ADR.md entry 45)
  // and a submit may name either. Harmless at every reader traced (the later real
  // submit overwrites cleanly, and `rounds[n].status` keeps the distinction this
  // loop's own comment is about), but "the reviewer left this blank" is a statement
  // about a round that has been sent, and writing it for a round nobody has answered
  // yet is a claim the board has no business making.
  for (const b of allQuestions) {
    if (answerable.has(b.id) && !board.answers[b.id]) {
      board.answers[b.id] = { id: b.id, status: 'unanswered', choice: null, note: '' };
    }
  }

  for (const c of comments || []) {
    if (!c || !c.text) continue;
    // A comment naming no real block is never a request the reviewer made
    // -- same reasoning as the answer-merge guard above, and the
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
      // The block's OWN kind at the moment this anchor was minted:
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
    // Recorded on the round, not just board-wide. `board.state` is reset to
    // 'open' by addRound, so a concurrent `ask` landing inside the waiter's 120ms
    // poll erased 'discuss' before buildPacket read it -- the blocked call then
    // reported "Board submitted." and the agent never got the stop instruction.
    // The round's own outcome cannot be overwritten by a later round.
    r.action = action === 'discuss' ? 'discuss' : 'submitted';
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
 * carries one (a `dom` anchor's `hint`, e.g. "Send button in After stage"), else the ref (a `mermaid` anchor's ref is already a
 * human-legible node id), else `fallback`. Never undefined, so a malformed or
 * hand-edited anchor still names *something*. */
function lostLabel(anchor, fallback) {
  return anchor?.hint || anchor?.ref || fallback;
}

// resolveComment's `dom` (non-html) and `mermaid` branches
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
    // htmlBodyRootFrom, not a bare parseHtmlTree: the cache exists
    // to parse/hoist once per block per pass, so it is exactly the place a
    // cached-but-unhoisted root would silently undo C2's fix for every
    // comment after the first on the same html-stage block.
    entry.stageRoot = htmlBodyRootFrom(block.html);
  }
  return entry.stageRoot;
}

/** Resolve one stored comment against the board's current blocks. One rule per anchor
 * kind, each reducing to src/anchor.mjs:
 *
 *  - `dom` on an html stage: `ref` must address an element in that block's snapshotted
 *    markup AND that element's own identity must back the stored `hint`
 *    (resolveDomAnchor) — both, never just the hint appearing somewhere in the block.
 *  - `dom` on any other kind: the same check against the block RE-RENDERED from its own
 *    stored content (src/render.mjs's `renderBlock`, exported for exactly this), rooted
 *    at the block's own section rather than a synthetic document root, and matching the
 *    element's identity rather than the full "identity in context" hint — see
 *    resolveDomAnchorInSection's own comment for why.
 *  - `mermaid`: resolveMermaidAnchorAtRoot, which makes that same section-rooted attempt
 *    FIRST against `domRef`/`hint` and falls back to the node id (`ref`) still appearing
 *    in the block's snapshotted diagram source. An anchor stored before that fallback
 *    existed carries no `domRef`/`hint` and resolves exactly as it always did, since the
 *    generic attempt returns false immediately for an absent ref.
 *  - `block`: always resolved, if the block is still there.
 *
 * An anchor that no longer resolves reports WHAT it lost rather than vanishing, and
 * `lost` always names *something* (lostLabel above), so a malformed or hand-edited
 * anchor still says what it lost instead of dropping the field.
 *
 * `blockCache` is optional and private to this module: every external caller keeps
 * calling `resolveComment(board, comment)` with an unchanged signature and unchanged
 * per-call cost. `resolveComments` below passes one, shared across a whole board's
 * comments, for the hot paths that resolve them all in a single pass. */
export function resolveComment(board, comment, blockCache = new Map()) {
  const block = findBlock(board, comment.blockId);
  const out = {
    n: comment.n,
    blockId: comment.blockId,
    blockKind: block ? block.kind : null,
    anchor: comment.anchor,
    text: comment.text,
    // `round` and `createdAt` are carried through, not dropped: without
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
  // ADR.md entry 28: there is no `md` branch any more. A stored `md` anchor from an
  // archived board falls through every branch below and stays `resolved`, exactly
  // like the whole-block comment on a `question` entry 28 already left unsupported --
  // the block it names renders no comment list at all now, so there is nothing for
  // a verdict to decorate.
  if (anchorKind === 'dom') {
    // `mintBlockKind` (applySubmit, above) is the block's own kind at
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
    // An 'html' block has TWO client-
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
    // ASSUMPTION FLAGGED: this reconciles against today's
    // client-side minting (`anchorRootFor` finds the SECTION for anything
    // inside an html block that is not `.html-stage`/chrome). If a future
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
 * per-block render+parse cache across all of them — the
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
 * Scoped to `round`: the packet answers the round that was just sent, not
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
  // The round's own recorded outcome wins over the board-wide state, which a later
  // round resets to 'open'. Falls back to board.state for rounds sent before
  // `action` was recorded, and for a round that has not been sent at all.
  const sentRound = board.rounds.find(r => r.n === round);
  return {
    board: board.id,
    thread: board.thread,
    title: board.title,
    round,
    status: sentRound?.action ?? board.state,
    answers,
    comments,
    url,
  };
}

// --- fields the daemon keeps on the board but never shows a client -------------
//
// The stranded rule (src/server.mjs's createStrandedWatch, SPEC_STRANDED.md) records on
// the board itself the banner it currently has standing for it, because the thing that
// record defends against is a daemon RESTART and an in-memory one is empty in exactly
// that case. One field holding one record rather than three parallel ones that must be
// written, cleared and stripped together:
//
//   board.strandedBanner = { at, until, round, pid } | null
//
//   at     when the banner went up, an ISO stamp like `sentAt`/`postedAt` beside it.
//          Also what bounds `pid` below: a process that started before this did is not
//          the one this record names, whatever it is called.
//   until  when the process serving the banner will exit and withdraw it -- the round's
//          own deadline, or the launcher's hard ceiling, whichever comes first. Used for
//          ONE thing: deciding whether `pid` is still worth signalling. Deliberately NOT
//          a term in whether the record SUPPRESSES -- a banner that has expired off the
//          screen still counts as this board's one announcement (criterion 7, read
//          literally).
//   round  which round the reviewer was told about, and the load-bearing field: the
//          absence ends when THIS round stops being awaited (answered, or its wait
//          lapsed), whereupon the next round on the board starts a fresh one.
//   pid    the process serving that banner's click, so a daemon that did not spawn it
//          can still withdraw it after an unclean restart. Null on the osascript
//          fallback, which has no process that outlives its post.
//
// Declared HERE rather than in src/server.mjs because `stripDaemonOnly` below is what
// strips it and src/render.mjs calls that; render.mjs cannot import from the server,
// which imports it.
export const STRANDED_BANNER = 'strandedBanner';

/** A shallow copy of `board` with that record removed, for anything a client sees.
 *
 * Not a nicety. The daemon writes the marker with `writeBoard` and does NOT re-render
 * the page (that would mean re-rendering a possibly multi-megabyte page board from a
 * timer callback), so if the marker reached the rendered payload, `GET /b/:id` would
 * serve markup that `pages/:id.html` on disk does not have -- breaking the invariant
 * test/check-http.mjs pins byte-for-byte ("the served page, the pages/ file on disk,
 * and a fresh renderBoardPage() of the stored JSON are all byte-identical"), which is
 * what makes an archived board openable from Finder with no daemon at all. Keeping
 * these out of the payload keeps the rendered bytes a pure function of the board's
 * REVIEWER-facing state, which is the property that invariant is really about. */
export function stripDaemonOnly(board) {
  const { [STRANDED_BANNER]: _banner, ...rest } = board;
  return rest;
}
