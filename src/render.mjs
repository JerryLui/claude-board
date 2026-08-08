// Board JSON -> complete HTML page, as a pure function of the JSON. The page
// inlines its own board JSON in a script tag: served through the daemon it hydrates
// and subscribes over SSE (see renderRoundSection and src/server.mjs);
// opened from Finder it hydrates from the embedded copy and renders read-only
// (src/ui.mjs decides based on `location.protocol`).
//
// Blocks are grouped into per-round <section class="round">s (renderRoundSection):
// a sent round renders as history, still fully readable, its widgets disabled; the
// open round renders live. src/server.mjs reuses renderRoundSection and renderBlock
// directly to render the fragment for an SSE push, so a full page load and a live
// push of the same round are byte-identical.
//
// All four answer widgets (single, multi, text, rank), all five context kinds
// (markdown, code, mermaid, html, compare), and comments anchored at block and at
// element level (dom path + hint, mermaid node id) render here. Only `html` and
// `mermaid` carry a comment affordance at all (ADR.md entry 28) -- `markdown`,
// `code`, `question` and `compare` render no comment button, form, list or pin
// layer, so a stored comment on one of those simply has nowhere to render.
// Every comment is run through resolveComment (src/board.mjs),
// via resolveComments' shared per-block cache, exactly once per render
// -- see groupCommentsByBlock and renderBoardPage below
// -- and that single resolved/lost verdict feeds both the server-rendered
// per-block comment list AND whatever gets embedded for the client to hydrate
// from (the full page's `#board-data`, or an SSE push's payload -- see
// src/server.mjs), so the pin src/ui.mjs draws and the comment list beside it can
// never disagree about whether an anchor still resolves.

import { styles, palettes, faviconLink, markSvg } from './styles.mjs';
import { ui } from './ui.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';
import { resolveComments } from './board.mjs';
import { buildSteps, stepsToPath, pathToSteps, resolveSteps } from './anchor.mjs';
import {
  badgeLabel, roundPageLabel, isPageRound,
  roundIsAwaitedOpen, PILL_READONLY_TITLE,
} from './badge.mjs';

/** Content-Security-Policy for every board page, both as the HTTP response
 * header src/server.mjs sends on every live request AND as the `<meta http-equiv>` renderBoardPage now
 * emits below. One string, not two independently-maintained policies: this is
 * the module both sides import it from, since src/server.mjs already imports
 * `renderBoardPage` itself from here (the reverse import would be circular).
 * The header is what protects a LIVE request; the meta tag is what protects an
 * archived board opened straight from disk with no daemon and no HTTP response
 * at all to carry a header on. `frame-ancestors` and `form-action` are silently
 * ignored when a policy is delivered via `<meta>` (a browser platform
 * limitation, not a mistake here) — `default-src`/`script-src`/`style-src`/
 * `img-src`/`font-src`/`connect-src`/`base-uri` are all still honoured, which is
 * the half that actually constrains a mock's own script: with
 * `allow-same-origin` dropped (see renderHtmlBlock's own design comment) the
 * stage can no longer forge same-origin fetches at all, but an archived page's
 * `#board-data` (the reviewer's own answers and comments) is worth defending in
 * depth even so — this closes an exploit (a mock's
 * script, same-origin with a `file://` parent, self-navigating to an external
 * URL with no CSP to stop it). Scoped to what the page genuinely uses: its own
 * inlined `<style>`/`<script>` (both emitted inline below, so `'unsafe-inline'`
 * is load-bearing, not laziness), mermaid's dynamic `import()` from jsdelivr
 * (src/ui.mjs), and same-origin fetch/EventSource — nothing else can load, no
 * form can post anywhere, no `<base>` can re-point a relative URL. */
const CSP_CLAUSES = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/mermaid@11.16.1/",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src data: https://cdn.jsdelivr.net/npm/mermaid@11.16.1/",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
];

export const CSP = [...CSP_CLAUSES, "form-action 'none'"].join('; ');

/** The index page's policy: the board `CSP` above with the one clause the index
 * genuinely needs relaxed. The index is the daemon's own chrome, and its archive
 * search is a plain `<form method="get" action="/">` round trip (see
 * src/indexpage.mjs) — under `form-action 'none'` the browser blocks the
 * submission outright and the search box is dead, which is exactly what it did
 * until this split existed. `'self'` allows that one same-origin GET and nothing
 * else: no cross-origin post, and every state-changing route is a POST behind the
 * origin check and the local secret regardless. This does NOT apply to board
 * pages, whose `html` stages are untrusted content and keep `'none'`. */
export const INDEX_CSP = [...CSP_CLAUSES, "form-action 'self'"].join('; ');

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

/** JSON.stringify, with `<` escaped so a `</script>` inside board content can't
 * terminate the inlining script tag early. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The comment glyph, as inline SVG rather than an emoji: an emoji renders at the
 * mercy of the platform's font (colour, weight and baseline all differ across
 * macOS/Windows/Linux, and it ignores `currentColor`, so it stayed loud while the
 * button around it went quiet). Inlined, not linked, like everything else the
 * standalone archive needs. */
const COMMENT_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/** The comment-mode toggle's icon: a crosshair, distinct from the comment glyph
 * above so the two controls don't read as the same affordance twice. See
 * "The gesture is an explicit comment mode": this
 * button is the one thing on the page that makes the generic element-level
 * gesture discoverable without being told it exists -- it has to be
 * visible chrome, not a held modifier or a hover-only affordance. src/ui.mjs reads
 * its id and toggles `.active` on it and `comment-mode` on `body`; its own click
 * never anchors anything (excluded from the click-to-anchor gesture by class, same
 * as the comment infrastructure it sits beside). */
const MODE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

/** The diagram-expand control's icon: four arrowheads
 * pointing out of the corners, the standard "open this full size" glyph and
 * distinct from the three above. Inline SVG for the same reason every other icon
 * here is — the standalone archive has no network to fetch anything from. */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/></svg>';

function commentModeToggle() {
  return `<button type="button" id="comment-mode-toggle" class="mode-toggle" aria-pressed="false">${MODE_ICON}<span class="mode-toggle-label">Comment mode: off</span></button>`;
}

/** The explicit control that opens a
 * diagram in the full-viewport lens. Explicit, and never the diagram itself —
 * "the click gesture on a diagram keeps its current meaning in both modes",
 * so clicking a node still means "comment on this node"
 * with comment mode on and still means nothing with it off.
 *
 * Rendered server-side rather than injected by src/ui.mjs so it is in the
 * standalone archive's own bytes, where the lens is still expected to pan and
 * zoom ("The lens is view-only under `body.readonly`" — view-only, not
 * absent). That is also why src/ui.mjs's readonly pass, which hard-disables
 * every other button on the page, skips this one by class.
 *
 * src/ui.mjs's `wireDiagramExpand` removes it again if mermaid never produced an
 * SVG (CDN unreachable, invalid chart): a control that opens an empty lens is
 * worse than no control.
 *
 * The same control appears on every `html` stage, and both
 * reasons above carry over unchanged — a stage in a standalone archive still
 * opens in the lens, so the button has to be in the archive's own bytes and has
 * to survive the readonly pass. `what` names the thing being opened in the
 * accessible name and is this file's own word, never board content; the two
 * kinds share one class, since the class is what src/ui.mjs's readonly carve-out
 * and the stylesheet both key on, and one control that behaves the same way in
 * two kickers should not be two. */
function expandButton(blockId, what) {
  return `<button type="button" class="expand-btn" data-expand-for="${escAttr(blockId)}" aria-label="Open this ${what || 'diagram'} in the lens">${EXPAND_ICON}expand</button>`;
}

/** The whole-block comment control. Emitted only by the two kinds ADR.md entry 28
 * leaves commentable (`html` and `mermaid`); every anchored comment on either of
 * those is minted by a click on the stage itself, never by a button, so this has
 * no inline/anchored variant any more. */
function commentButton(blockId) {
  return `<button type="button" class="comment-btn" data-block-id="${escAttr(blockId)}" data-anchor-kind="block">${COMMENT_ICON}comment</button>`;
}

/** The short label shown next to a comment's number in its block's comment list:
 * the dom hint ("the Send button"), a diagram
 * node's own hint falling back to its bare node id for an anchor
 * minted before that ticket, or "block" for a whole-block comment — and
 * "lost: <ref>" for any of
 * those once resolveComment (src/board.mjs) has decided the anchor no longer
 * resolves, so a stale anchor names what it lost instead of rendering as if
 * nothing happened. */
function anchorTag(c, lost) {
  if (lost) return `lost: ${c.lost}`;
  const kind = c.anchor && c.anchor.kind;
  if (kind === 'dom') return c.anchor.hint || c.anchor.ref;
  // A diagram node's anchor now carries a hint too (composeHint, the
  // same rule as every other element) -- preferred exactly like `dom` above,
  // falling back to the bare node id for a pre-ticket-05 anchor that has none.
  if (kind === 'mermaid') return c.anchor.hint || c.anchor.ref;
  return 'block';
}

/** `historical` disables the comment form itself (not the existing comment list,
 * which stays visible either way) once the block's round has been sent — see
 * renderQuestionBlock's doc comment for why: a sent round's whole surface,
 * comments included, renders inert rather than staying a second place to add to
 * an exchange that already went out. */
/** The `<div class="comment-item">` list, shared by `commentArea` below and the
 * page board's own panel (`renderPageCommentPanel`): one rendering of a block's
 * stored comments, so the two surfaces can never disagree about how a comment's
 * anchor tag or lost/resolved styling is drawn. */
function commentItemsHtml(blockId, commentsByBlock) {
  const comments = commentsByBlock.get(blockId) || [];
  return comments.map(c => {
    const lost = !c.resolved;
    const tag = anchorTag(c, lost);
    // The anchor a list entry points at, re-emitted as data attributes so nothing
    // downstream has to re-derive it from the rendered text. (The click-to-highlight
    // gesture these fed went with the `md` anchor kind -- ADR.md entry 28; an
    // element-level comment on a stage or a diagram already carries a numbered pin
    // drawn on the thing it is about.)
    const kind = (c.anchor && c.anchor.kind) || 'block';
    const ref = (c.anchor && c.anchor.ref) || '';
    return `<div class="comment-item" data-anchor-kind="${escAttr(kind)}"${ref ? ` data-anchor-ref="${escAttr(ref)}"` : ''} data-block-id="${escAttr(blockId)}"><span class="comment-anchor${lost ? ' comment-lost' : ''}">#${c.n} · ${escHtml(tag)}</span>${escHtml(c.text)}</div>`;
  }).join('');
}

/** `historical` disables the comment form itself (not the existing comment list,
 * which stays visible either way) once the block's round has been sent — see
 * renderQuestionBlock's doc comment for why: a sent round's whole surface,
 * comments included, renders inert rather than staying a second place to add to
 * an exchange that already went out. */
function commentArea(blockId, commentsByBlock, historical) {
  const items = commentItemsHtml(blockId, commentsByBlock);
  return `
    <div class="comment-target" id="comment-target-${escAttr(blockId)}">commenting on: whole block</div>
    <form class="comment-form" id="comment-form-${escAttr(blockId)}" data-block-id="${escAttr(blockId)}" data-anchor-kind="block">
      <input type="text" placeholder="Add a comment"${historical ? ' disabled' : ''}>
      <button type="submit"${historical ? ' disabled' : ''}>Add</button>
    </form>
    <div class="comment-list" id="comment-list-${escAttr(blockId)}">${items}</div>`;
}

/** The generic element-level pin overlay for a block whose content lives in the
 * board's OWN document (as opposed to html/mermaid's stage-scoped one inside
 * `.stage-wrap` -- see src/anchor.mjs's design comment for the two roots). A
 * direct child of the `.block` section itself, `inset: 0` over the whole section
 * (the same `.pin-layer`/`.anchor-pin` rules already used for the stage case,
 * reused as-is -- `.block` is already `position: relative`), so a pin's position
 * is correct regardless of where inside the section the anchored element sits.
 * src/ui.mjs finds it by walking `section.children` directly, never by a deep
 * `querySelector` -- a nested block (a compare side, a question's context) has
 * its own section and its own pin-layer, and a deep search from the OUTER
 * section could otherwise find the INNER one instead. */
function pageDomPinLayer(blockId) {
  return `<div class="pin-layer" data-block-id="${escAttr(blockId)}"></div>`;
}

/** A stage (an html iframe, a mermaid `<pre>`) and the absolutely-positioned pin
 * layer over it, inside the `position: relative` wrapper the two need to line up.
 * renderMermaidBlock and renderHtmlBlock write this same shape inline, each in
 * its own section's indentation; this exists for renderContextItem, which needs
 * the identical structure for a stage rendered as prose under a question's
 * prompt. Left as a third spelling rather than folded into those two, because
 * both of theirs sit inside larger template literals whose exact emitted text a
 * handful of checks match on. */
function stageWrap(blockId, inner) {
  return `<div class="stage-wrap">
    ${inner}
    <div class="pin-layer" data-block-id="${escAttr(blockId)}"></div>
  </div>`;
}

/** No commentButton/commentArea/pageDomPinLayer here (ADR.md entry 28, "Only the
 * rendered kinds can be commented on"): the reviewer comments on rendered output,
 * never on prose, so `markdown` carries neither the button nor the click-to-anchor
 * gesture, wherever it appears — including nested in a question's context or a
 * compare side. Same shape entry 6 already gave `question`/`compare`; an archived
 * board carrying a stored comment on this block simply renders without it, since
 * there is no list here to render it into. `block.anchors` and the heading/list-item
 * `id` attributes stay (they are stored state, and the ids are what
 * test/check-archive-ids.mjs's collision guard is about) — what is gone is the
 * `md` COMMENT anchor kind that used to point at them. */
function renderMarkdownBlock(block) {
  if (block.error) {
    return `
<section class="block markdown-block" data-block-id="${escAttr(block.id)}" data-block-kind="markdown">
  <div class="block-kicker">Markdown</div>
  <p class="resolve-error">Could not resolve: ${escHtml(block.error)}</p>
</section>`;
  }
  return `
<section class="block markdown-block" data-block-id="${escAttr(block.id)}" data-block-kind="markdown">
  <div class="block-kicker">Markdown</div>
  <div class="md-content">${block.html}</div>
</section>`;
}

// --- answer widgets -----------------------------------------------------------
//
// Each widget renders the options/answer surface only; the note field, defer
// button and status line are shared chrome in renderQuestionBlock below. Every
// widget sets data-question-id / data-choice (or data-answer-for) so src/ui.mjs can
// read the current value generically without per-widget branching at Send time.

/** `opt.preview` is a plain string: rendered as an <img> when it looks like an image
 * URL, otherwise as a small preformatted snippet. No markdown/code rendering here —
 * a preview is a glance, not a second content block. */
function renderOptionPreview(preview) {
  const trimmed = String(preview ?? '').trim();
  // Parsed, not pattern-matched. The old sniff
  // `^https?://\S+\.(png|...)(\?\S*)?$` let `\S+` and `\S*` compete for a `$` a
  // trailing newline made unreachable, so a crafted `.png?`-repeated string cost
  // O(n^2) -- ~46s at 400KB, and paid again on every read because the board is
  // persisted after the render. URL parsing is linear and answers the same question.
  let looksLikeImage = false;
  try {
    const u = new URL(trimmed);
    looksLikeImage = (u.protocol === 'http:' || u.protocol === 'https:')
      && /\.(png|jpe?g|gif|webp|svg)$/i.test(u.pathname);
  } catch { /* not a URL: render as a snippet, same as before */ }
  if (looksLikeImage) {
    // The emitted src is the string that was vetted, not the raw one -- same
    // discipline as stripUrlControls in src/markdown.mjs.
    return `<img class="opt-preview opt-preview-img" src="${escAttr(trimmed)}" alt="">`;
  }
  return `<pre class="opt-preview opt-preview-code">${escHtml(preview)}</pre>`;
}

function renderOptionBody(opt) {
  return `<span class="opt-main">
      <span class="opt-label">${escHtml(opt.label)}</span>
      ${opt.description ? `<span class="opt-desc">${escHtml(opt.description)}</span>` : ''}
    </span>${opt.preview ? renderOptionPreview(opt.preview) : ''}`;
}

/** Single-choice: cards for every option, all visible at once (the whole point
 * versus the terminal tool — no scrolling one option at a time). `historical` is
 * true once the round this block belongs to has been sent: the choice already made
 * stays visible (see PROTOCOL.md "Board document" — answers are keyed at board
 * level, so a sent round's blocks still carry their answer) but the control is
 * rendered `disabled` so it can never be nudged into changing a decision that was
 * already sent, nor accidentally re-included by a later Send. */
function renderSingleChoice(block, answer, historical) {
  const selected = answer && typeof answer.choice === 'string' ? answer.choice : null;
  const cards = block.options.map(opt => {
    const isSel = selected === opt.label;
    return `<button type="button" class="card-choice choice-single${isSel ? ' selected' : ''}" data-question-id="${escAttr(block.id)}" data-choice="${escAttr(opt.label)}"${historical ? ' disabled' : ''}>
      ${renderOptionBody(opt)}
    </button>`;
  }).join('');
  return `<div class="options">${cards}</div>`;
}

/** Multi-select: same cards, toggled independently; choice is the array of selected
 * labels (order not meaningful — see rank for ordering). */
function renderMultiChoice(block, answer, historical) {
  const selected = answer && Array.isArray(answer.choice) ? answer.choice : [];
  const cards = block.options.map(opt => {
    const isSel = selected.includes(opt.label);
    return `<button type="button" class="card-choice choice-multi${isSel ? ' selected' : ''}" data-question-id="${escAttr(block.id)}" data-choice="${escAttr(opt.label)}"${historical ? ' disabled' : ''}>
      <span class="opt-check" aria-hidden="true"></span>
      ${renderOptionBody(opt)}
    </button>`;
  }).join('');
  return `<div class="options">${cards}</div>`;
}

/** Free text: a comfortable writing surface, not a cramped input — this is the
 * capability the terminal tool lacks entirely. */
function renderTextWidget(block, answer, historical) {
  const value = answer && typeof answer.choice === 'string' ? answer.choice : '';
  return `<textarea class="answer-textarea" data-answer-for="${escAttr(block.id)}" rows="8" placeholder="Write your answer…"${historical ? ' disabled' : ''}>${escHtml(value)}</textarea>`;
}

/** Drag-to-rank: every option, in the stored order if there is a prior answer, else
 * options order. The answer is the ordered array of option labels; the drag gesture
 * itself lives in src/ui.mjs and is not asserted by the node checks (that check
 * "is not automated and should not pretend to
 * be"), but the markup and data shape here are. */
function renderRankWidget(block, answer, historical) {
  const hasOrder = answer && Array.isArray(answer.choice) && answer.choice.length;
  const order = hasOrder ? answer.choice : block.options.map(o => o.label);
  const byLabel = new Map(block.options.map(o => [o.label, o]));
  const items = order.map((label, i) => {
    const opt = byLabel.get(label) || { label };
    return `<li draggable="${historical ? 'false' : 'true'}" data-choice="${escAttr(label)}">
      <span class="rank-index">${i + 1}</span>
      <span class="rank-grip" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
      ${renderOptionBody(opt)}
    </li>`;
  }).join('');
  return `<ul class="rank-list" data-question-id="${escAttr(block.id)}">${items}</ul>`;
}

/** choose-between-rendered-variants: each option carries a nested,
 * fully rendered content block instead of the plain string `preview` every
 * other widget's option has (renderOptionBody/renderOptionPreview above are
 * for those; this widget bypasses both). The reviewer picks by clicking the
 * option's own card, which cannot be a `<button>` the way every other
 * card-choice widget's is: an option's block can be `html`, a sandboxed
 * iframe (renderHtmlBlock below), and interactive content nested inside a
 * `<button>` is invalid HTML the browser will not let the reviewer click
 * through to. So the selectable unit is a plain, focusable `<div
 * role="button">`, wired by hand in src/ui.mjs for the same click + keyboard
 * contract a real `<button>` gives for free -- see that file's own comment on
 * `.choice-variant` for the keyboard half and the guard against stealing a
 * click meant for the option's own comment button/form.
 *
 * An `html` option's iframe is rendered `pointer-events: none` inside a
 * `.choice-variant` card (src/styles.mjs) -- deliberately, not an oversight:
 * see stageAgentScript's own design comment ("NO 'select' MESSAGE,
 * DELIBERATELY") for why the stage must never be able to influence its own
 * selection. The option's block is untrusted, agent-authored content, same as
 * any other block on the page; unlike everywhere else that content renders,
 * here a click deciding WHICH option gets picked is a decision only the
 * reviewer may make. So a real click over the mock's visible content can
 * never reach the iframe at all -- it lands on the card in the parent
 * document instead, the same as a click on the option's label or border
 * already does. The block-level comment button/form still work exactly like
 * any other block's (they render in the parent document, not the iframe); an
 * `html` option's own element-level comment-anchor gesture does not, as the
 * same consequence of being unclickable -- a lesser loss than the one it
 * closes, and the other content kinds (markdown/code/mermaid/compare) render
 * inline with no iframe at all, so theirs is unaffected.
 *
 * `historical` renders the card `aria-disabled="true"` and out of the tab
 * order (`tabindex="-1"`) -- the div equivalent of every other widget's
 * `disabled` attribute, since a plain `<div>` has no native disabled state a
 * browser enforces on its own the way `<button disabled>` does; src/ui.mjs's
 * click/keydown handlers both check for it before acting. The picked
 * option's `.selected` class is driven by `answer.choice` exactly like every
 * other widget, so it stays visible once the round is sent (PROTOCOL.md
 * "Board document" -- answers are keyed at board level).
 *
 * The nested block renders through the exact same `renderBlock` dispatch a
 * compare side or a question's own `context` block already goes through --
 * its own id (src/board.mjs's normalizeBlock, competing for ids in the same
 * shared ledger a compare side's `block` does), its own comment button/form/
 * pin-layer, all for free. That is a deliberate choice, not an oversight: an
 * option's block is exactly as commentable AT BLOCK LEVEL as a compare side's
 * block already is (src/board.mjs's findBlock/questionBlocks walk
 * `options[].block` the same way they walk `left`/`right`), rather than this
 * one widget inventing a suppressed, comment-free rendering path of its own.
 *
 * An `html`-kind option carries the modifier class
 * `variant-card--stage` (src/styles.mjs: `grid-column: 1 / -1`), which is what
 * takes it out of `.options-variants`' three-column grid and onto its own full-
 * width row -- three columns leaves an `html` mock's own text unreadably small,
 * which is the whole problem this widget existed to fix and previously didn't.
 * Every other block kind (markdown/code/mermaid/compare) keeps the plain grid
 * untouched, on the same reasoning `renderHtmlBlock`'s own header comment gives
 * for why only `html` needed the sandboxed-iframe treatment in the first place:
 * they render inline, at whatever width the grid already gives them, with no
 * unreadable-at-a-third-width problem to solve. */
function renderVariantOption(opt, isSelected, board, commentsByBlock, historical, questionId) {
  const body = opt.block
    ? renderBlock(opt.block, board, commentsByBlock, historical)
    : '<p class="unsupported-widget">no content</p>';
  const stageModifier = opt.block && opt.block.kind === 'html' ? ' variant-card--stage' : '';
  return `<div class="variant-card choice-variant${stageModifier}${isSelected ? ' selected' : ''}" role="button" tabindex="${historical ? '-1' : '0'}"${historical ? ' aria-disabled="true"' : ''} data-question-id="${escAttr(questionId)}" data-choice="${escAttr(opt.label)}">
    <div class="variant-label">
      <span class="opt-label">${escHtml(opt.label)}</span>
      ${opt.description ? `<span class="opt-desc">${escHtml(opt.description)}</span>` : ''}
    </div>
    ${body}
  </div>`;
}

function renderVariantChoice(block, answer, historical, board, commentsByBlock) {
  const selected = answer && typeof answer.choice === 'string' ? answer.choice : null;
  const cards = block.options
    .map(opt => renderVariantOption(opt, selected === opt.label, board, commentsByBlock, historical, block.id))
    .join('');
  return `<div class="options options-variants">${cards}</div>`;
}

function renderWidget(block, answer, historical, board, commentsByBlock) {
  switch (block.widget) {
    case 'single': return renderSingleChoice(block, answer, historical);
    case 'multi': return renderMultiChoice(block, answer, historical);
    case 'text': return renderTextWidget(block, answer, historical);
    case 'rank': return renderRankWidget(block, answer, historical);
    case 'choose-between-rendered-variants': return renderVariantChoice(block, answer, historical, board, commentsByBlock);
    // Unreachable through createBoard/addRound/amendRound: src/board.mjs's
    // normalizeBlock rejects any `widget` not in WIDGETS before a block is ever
    // minted, so every block renderWidget ever sees already named
    // one of the five cases above. This used to be `default: return
    // renderSingleChoice(...)` -- permissive, so a SIXTH WIDGETS entry added
    // without a matching case here would render silently as an empty list of
    // single-choice cards, indistinguishable from a data bug rather than a
    // renderer gap. Thrown instead, matching board.mjs's own "a 400 naming the
    // widget is recoverable; a silent fallback is not" reasoning -- loud, at
    // the one place that can name which widget's case is missing.
    default: throw new Error(`renderWidget: no render case for widget ${JSON.stringify(block.widget)}`);
  }
}

/** True when a block IS a rendered stage, or wraps one -- an `html` block
 * itself, or a `compare` whose left or right side nests one. ADR.md entry 26:
 * "the full-width rule keys on the presence of a rendered stage, not on the
 * widget kind." Recurses into `compare` only -- context's other four kinds
 * (markdown, code, mermaid) never carry a stage of their own. */
function blockCarriesStage(block) {
  if (!block) return false;
  if (block.kind === 'html') return true;
  if (block.kind === 'compare') {
    return blockCarriesStage(block.left && block.left.block) || blockCarriesStage(block.right && block.right.block);
  }
  return false;
}

/** True when a question's own options or its context carry a rendered stage
 * anywhere -- the single condition renderQuestionBlock keys both the
 * full-width layout and the context-as-prose rendering on (ADR.md entry 26).
 * Only `choose-between-rendered-variants` ever nests a block inside an
 * option; every other widget's options are plain label/description pairs. */
function questionCarriesStage(block) {
  const inContext = (block.context || []).some(blockCarriesStage);
  const inOptions = block.widget === 'choose-between-rendered-variants'
    && (block.options || []).some(opt => blockCarriesStage(opt && opt.block));
  return inContext || inOptions;
}

/** A context block's bare content, with none of `.block`'s card chrome --
 * ADR.md entry 26, "context stacks under the prompt as plain prose with no
 * card, no kicker": no `.block` border/background, no `.block-kicker` label.
 * Reuses `.md-content`'s own prose/code styling for both markdown and code (a
 * fenced fragment reads the same as one embedded in prose either way) and
 * `.mermaid-block`'s borderless-`<pre>` rule for mermaid, so no new CSS is
 * needed for either. `data-block-id`/`data-block-kind` ride on the wrapper
 * (renderContextItem below), which is both a stable "which block is this" hook
 * and the attribute src/ui.mjs's kind check reads.
 *
 * Entry 26 also said "no comment control", and entry 28 SUPERSEDES that half:
 * the comment rule is drawn on kind and never on position, so an `html` stage
 * or a `mermaid` diagram is exactly as commentable here as at the top level.
 * That affordance is added by renderContextItem below rather than here, because
 * it is chrome ABOUT the content rather than part of it -- and it is none of the
 * three things entry 26 actually removed (a card, a border, a kicker), so both
 * rules hold at once. `markdown` and `code` keep no affordance, here or
 * anywhere. */
function renderContextInner(block, board, commentsByBlock, historical) {
  switch (block.kind) {
    case 'markdown':
      return block.error ? resolveErrorNote(block) : `<div class="md-content">${block.html}</div>`;
    case 'code':
      return block.error ? resolveErrorNote(block) : `<div class="md-content"><pre><code>${escHtml(String(block.text ?? ''))}</code></pre></div>`;
    case 'mermaid':
      return block.error ? resolveErrorNote(block) : stageWrap(block.id, `<pre class="mermaid">${escHtml(block.text)}</pre>`);
    case 'html':
      return block.error ? resolveErrorNote(block)
        : stageWrap(block.id, `<iframe class="html-stage" sandbox="allow-scripts" srcdoc="${escAttr(buildStageSrcdoc(block))}"></iframe>`);
    case 'compare':
      return `<div class="compare-grid">${renderContextCompareSide(block.left, board, commentsByBlock, historical)}${renderContextCompareSide(block.right, board, commentsByBlock, historical)}</div>`;
    default:
      // Anything this switch has no prose form for -- a `question` above all -- renders
      // as its full block rather than as nothing. Returning '' here meant a question
      // nested in a stage-carrying question's `context` produced an EMPTY context-item:
      // no prompt, no widget, nothing on screen. questionBlocks still walked it, so
      // applySubmit backfilled `unanswered` and the packet told the agent the reviewer
      // left blank a question they were never shown -- the same outcome src/board.mjs
      // refuses an unknown widget for. Worse, bin/mcp.mjs counts it as a question and
      // blocks the ask on /wait, so the call sat for the full two-hour cap on something
      // the page could not draw. The identical block under a stage-free question always
      // rendered fine; only this fork dropped it.
      return renderBlock(block, board, commentsByBlock, historical);
  }
}

function renderContextCompareSide(side, board, commentsByBlock, historical) {
  const label = side && side.label ? side.label : '';
  const body = side && side.block
    ? renderContextItem(side.block, board, commentsByBlock, historical)
    : '<p class="unsupported-widget">no content</p>';
  return `<div class="compare-side">
    <div class="compare-label">${escHtml(label)}</div>
    ${body}
  </div>`;
}

/** One context entry: its bare content, plus -- for the two kinds ADR.md entry
 * 28 leaves commentable -- the same comment affordance that kind carries at the
 * top level. The wrapper takes the kind's own `.html-block`/`.mermaid-block`
 * class as well, because every lookup in src/ui.mjs that finds a stage's pin
 * layer, its block id or its diagram source walks up to one of those two class
 * names (`frame.closest('.html-block')`, `preEl.closest('.mermaid-block')`,
 * `qsa('.mermaid-block', root)`); neither class carries any card styling of its
 * own -- that comes from `.block`, which is exactly what a context item does not
 * get -- so wearing it costs nothing visual and is what makes the affordance
 * genuinely work rather than merely render.
 *
 * `pageDomPinLayer` rides along on those two kinds for the same reason
 * renderMermaidBlock emits one: a failed reference renders a
 * `.resolve-error` note, which is not chrome and IS anchorable, so a click there
 * must have a layer to draw its pin into rather than resolving to a comment with
 * no pin anywhere on the page. */
function renderContextItem(block, board, commentsByBlock, historical) {
  const commentable = block.kind === 'html' || block.kind === 'mermaid';
  const kindClass = block.kind === 'html' ? ' html-block' : block.kind === 'mermaid' ? ' mermaid-block' : '';
  // Mirrors what the two kinds do at top level, which this used to get wrong for
  // one of them. `mermaid` renders inline in THIS document, so its page layer is
  // where a `dom` anchor on the block's own chrome belongs and renderMermaidBlock
  // emits one unconditionally. A healthy `html` stage's anchors all live inside
  // the frame and are drawn in the layer stageWrap already emits; renderHtmlBlock
  // therefore emits a page layer only on the error path, and this did it always --
  // giving a context-nested stage two layers, so wirePageDomPins found the second
  // one and drew every stage-scoped comment a SECOND time, at a fabricated
  // position, from refs that cannot resolve outside the frame.
  const pinLayer = block.kind === 'mermaid' || block.error ? pageDomPinLayer(block.id) : '';
  const affordance = commentable
    ? `${commentButton(block.id)}${pinLayer}${commentArea(block.id, commentsByBlock, historical)}`
    : '';
  return `<div class="context-item${kindClass}" data-block-id="${escAttr(block.id)}" data-block-kind="${escAttr(block.kind)}">${renderContextInner(block, board, commentsByBlock, historical)}${affordance}</div>`;
}

/** No commentButton/commentArea/pageDomPinLayer here (ADR "Commenting is
 * confined to content blocks", 2026-08-01): `question` is a card around a
 * widget, not content of its own -- a comment anchored to the whole card
 * names no item the agent can act on, and says strictly less than the `note`
 * field on the same card already says.
 *
 * Context rendering forks on whether the question carries a rendered stage
 * anywhere in its options or its own context (`questionCarriesStage`, ADR.md
 * entry 26). A question with no stage is untouched: its context still goes
 * through renderBlock exactly as before, in its own `.question-context` card
 * beside `.question-main` -- the pre-existing `.question-block:not(:has(
 * .question-context))` rule is what already collapses THAT case to one
 * column, so a stage-free question keeps today's markup byte for byte. A
 * question that DOES carry a stage renders its context as bare prose
 * (renderContextItem) stacked inside `.question-main`, between the prompt and
 * the widget, and never emits a `.question-context` card at all -- which is
 * what lets the SAME pre-existing `:not(:has(.question-context))` rule carry
 * the full-width layout too, with no new grid CSS of its own. */
function renderQuestionBlock(block, board, commentsByBlock, historical) {
  const answer = board.answers[block.id];
  const statusText = `status: ${answer ? answer.status : 'unanswered'}`;
  const isDeferred = !!(answer && answer.status === 'deferred');
  const widgetHtml = renderWidget(block, answer, historical, board, commentsByBlock);
  const contextItems = block.context || [];
  const stagey = questionCarriesStage(block);
  const proseContextHtml = stagey && contextItems.length
    ? `<div class="question-context-prose">${contextItems.map(c => renderContextItem(c, board, commentsByBlock, historical)).join('')}</div>`
    : '';
  const cardContextHtml = !stagey && contextItems.length
    ? contextItems.map(c => renderBlock(c, board, commentsByBlock, historical)).join('')
    : '';
  return `
<section class="block question-block" data-block-id="${escAttr(block.id)}" data-block-kind="question" data-widget="${escAttr(block.widget)}">
  <div class="question-main">
    <div class="block-kicker">Question · ${escHtml(block.widget)}</div>
    <p class="question-prompt">${escHtml(block.prompt)}</p>
    ${proseContextHtml}
    ${widgetHtml}
    <div class="note-field">
      <label for="note-${escAttr(block.id)}">Note</label>
      <textarea id="note-${escAttr(block.id)}" data-note-for="${escAttr(block.id)}" placeholder="Optional note"${historical ? ' disabled' : ''}>${escHtml(answer ? answer.note : '')}</textarea>
    </div>
    <div class="question-footer">
      <button type="button" class="btn-defer${isDeferred ? ' active' : ''}" data-defer-for="${escAttr(block.id)}"${historical ? ' disabled' : ''}>Defer</button>
      <span class="answer-status" data-status="${escAttr(answer ? answer.status : 'unanswered')}">${escHtml(statusText)}</span>
    </div>
  </div>
  ${cardContextHtml ? `<div class="question-context">${cardContextHtml}</div>` : ''}
</section>`;
}

// --- context / content block kinds ---------------------------------------------

function resolveErrorNote(block) {
  return block.error ? `<p class="resolve-error">Could not resolve: ${escHtml(block.error)}</p>` : '';
}

/** Mermaid stays client-side from its CDN exactly as /visualize does today —
 * "the daemon renders markdown; the page renders mermaid" — the
 * daemon only emits the raw diagram source in a `pre.mermaid`, and src/ui.mjs finds
 * and renders every such node in the page. The stage-scoped `pin-layer` nested in
 * `.stage-wrap` is an empty, absolutely positioned sibling that src/ui.mjs
 * populates once mermaid has rendered: it is where numbered pins for `mermaid`
 * anchors (a diagram node) land, never written to here since it depends on the
 * client-rendered SVG's node positions.
 *
 * That stage-scoped layer is NOT a direct child of this `.block` section (it is
 * nested one level deeper, inside `.stage-wrap`), so `directChildPinLayer`
 * (src/ui.mjs) never finds it and `wirePageDomPins` skips this section entirely.
 * A generic page-scoped `dom` anchor can still land here: on
 * `.stage-wrap`'s own padding (not itself excluded from the click gesture), or on
 * the `.resolve-error` note when the diagram source failed to resolve, since
 * neither is chrome and both sit inside a section the reviewer can see. The
 * second, direct-child `pageDomPinLayer` below is where THOSE anchors draw their
 * pin — a second, independent layer coexisting with the stage-scoped one, never
 * populated by the same code path (renderDomPins filters `kind === 'dom'`,
 * renderMermaidPins filters `kind === 'mermaid'`). */
function renderMermaidBlock(block, board, commentsByBlock, historical) {
  const body = block.error ? resolveErrorNote(block) : `
  <div class="stage-wrap">
    <pre class="mermaid">${escHtml(block.text)}</pre>
    <div class="pin-layer" data-block-id="${escAttr(block.id)}"></div>
  </div>`;
  return `
<section class="block mermaid-block" data-block-id="${escAttr(block.id)}" data-block-kind="mermaid">
  <div class="block-kicker">Mermaid ${commentButton(block.id)} ${block.error ? '' : expandButton(block.id)}</div>
  ${body}
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
}

function sourceLabel(source) {
  if (!source) return '';
  let label = source.path;
  if (source.section) label += `#${source.section}`;
  if (source.lines) label += `:${source.lines[0]}-${source.lines[1]}`;
  return label;
}

/** A file plus a line range or section, resolved once at post time (see
 * src/resolve.mjs). No syntax highlighting — a
 * hand-rolled cost zero-dependency packaging doesn't buy.
 *
 * No commentButton/commentArea/pageDomPinLayer, same as renderMarkdownBlock above
 * (ADR.md entry 28). The per-line `<span class="code-line">` wrapping went with
 * them: its only job was to give the generic dom anchor an element per source line
 * to build a step-path to, and a code line is no longer a comment target anywhere.
 * `<pre>` still renders one visual line per source line from the raw text, and
 * copy/paste is now exactly the original bytes rather than the spans stripped. */
function renderCodeBlock(block) {
  const label = sourceLabel(block.source);
  const kicker = ['Code', block.lang, label].filter(Boolean).map(escHtml).join(' · ');
  const body = block.error ? resolveErrorNote(block) : `<pre><code>${escHtml(String(block.text ?? ''))}</code></pre>`;
  return `
<section class="block code-block" data-block-id="${escAttr(block.id)}" data-block-kind="code">
  <div class="block-kicker">${kicker}</div>
  ${body}
</section>`;
}

// --- design: genuine stage isolation via postMessage -----------------
//
// "Isolation of hand-mocked HTML is kept": a
// mock's CSS and markup must never leak into or clash with the board page. Before
// this ticket that promise was false for SCRIPT: the iframe below carried
// `sandbox="allow-same-origin allow-scripts"`, and `allow-same-origin` on a
// `srcdoc` frame keeps the embedder's origin -- so a `<script>` in agent-supplied
// `block.html` ran as first-party at the daemon's own origin, could read/write
// the parent document, and could fetch every board on the
// machine and answer another agent's blocked `ask()` with attacker-chosen text.
// `allow-same-origin` is DROPPED below: the frame's browsing context now has an
// OPAQUE origin, `frame.contentDocument`/`frame.contentWindow.document` throw or
// return null from the parent's side, and a script inside the mock cannot reach
// the parent's window/document at all (test/check-stage-isolation.mjs proves
// this directly, and test/dom-stand-in.mjs's StandInWindow models a stage's
// `window.parent` as an object exposing ONLY `postMessage`, never `.document`,
// for the same reason).
//
// That means the parent can no longer reach into the stage to build a step path,
// read an element's text, or draw a pin from its live layout -- everything
// src/ui.mjs's old `wireHtmlStage` did directly. So the stage needs its own
// agent: STAGE_SCRIPT below, inlined into every html block's `srcdoc` (never a
// URL -- QUIRKS.md "no external assets, ever"), alongside whatever the mock
// itself supplies. It and the parent (src/ui.mjs's message listener, see that
// file's own copy of this design comment) talk over `postMessage`, and nothing
// else.
//
// MESSAGES. Every message is a plain object carrying `cb: 'cb-stage'` (a marker
// namespacing this channel from anything else that might ever postMessage this
// window -- a browser extension, devtools, a future unrelated feature) and a
// `type`. Neither side ever trusts a message's SHAPE beyond what it explicitly
// checks -- the stage document is attacker-controlled, so the parent has to
// assume the mock's own script sends it hostile messages on the same channel our
// own agent uses, and validates every field's type before acting on it.
//
//   STAGE -> PARENT
//     'ready'                          -- the agent has attached its listeners;
//                                          sent once, unconditionally, at the end
//                                          of this script (see below).
//     'hover'  { ref, tag, text }       -- the innermost element under the cursor
//                                          (ref = a buildSteps/stepsToPath index
//                                          chain from `document.body`, or null on
//                                          mouseout), so the parent CAN show a
//                                          hint before commit -- the stage still
//                                          applies its OWN outline locally
//                                          (ensureHoverStyle/clearHover below),
//                                          exactly as before this ticket, since
//                                          that never needed to leave the stage's
//                                          own document.
//     'click'  { ref, tag, text }       -- the clicked element's step path plus
//                                          its RAW tag/text -- never a composed
//                                          hint. Composing "identity in context"
//                                          (composeHint, src/anchor.mjs) needs
//                                          the OUTER document's own knowledge of
//                                          whether this stage sits inside a
//                                          compare side, which the stage cannot
//                                          see -- so the parent, not the stage,
//                                          calls buildHint on the raw tag/text it
//                                          receives, through the exact same
//                                          function every other content kind's
//                                          click already used. This is also why
//                                          `composeHint` needs no THIRD copy
//                                          embedded here alongside src/ui.mjs's
//                                          own (single-source discipline): only
//                                          `buildSteps`/`stepsToPath`/
//                                          `pathToSteps`/`resolveSteps` do, bound
//                                          below via `.toString()` from
//                                          src/anchor.mjs exactly like
//                                          src/ui.mjs's own embedded
//                                          `composeHint` -- never hand-copied.
//     'positions' { requestId, positions } -- the response to a 'locate'
//                                          request: for every requested ref,
//                                          `{left, top}` relative to this
//                                          document's own `<body>` (the SAME
//                                          formula src/ui.mjs's old
//                                          `renderDomPins` used when it could
//                                          still read `doc.body` directly), or
//                                          `null` if that ref no longer
//                                          resolves. Never anything but numbers
//                                          and null -- the parent only ever uses
//                                          this to position a pin it already
//                                          decided to draw from its own,
//                                          server-verdict-derived comment list
//                                          (src/ui.mjs's `commentsWithPending`),
//                                          never to decide WHETHER a pin exists.
//
//   PARENT -> STAGE
//     'mode' { commentMode }            -- comment mode turned on/off. The stage
//                                          keeps its OWN local `commentMode`
//                                          flag, read by the same
//                                          `if (!commentMode) return;` guards
//                                          `wireHtmlStage`'s old in-parent
//                                          listeners used, so hover/cursor/click
//                                          obey the toggle exactly as they did
//                                          before this ticket -- one
//                                          gesture, toggle-gated everywhere. The hover
//                                          stylesheet itself is injected
//                                          LAZILY, the first time `commentMode`
//                                          turns true (not at script start) --
//                                          a read-only archive never sends this
//                                          message at all (src/ui.mjs's
//                                          `setCommentMode` refuses to turn
//                                          comment mode on when `readonly`), so
//                                          an archived stage's document never
//                                          gains a hover stylesheet, matching
//                                          this ticket's unchanged behavioural
//                                          contract (test/check-archive.mjs).
//     'locate' { requestId, refs }      -- asks for the current `{left, top}`
//                                          of every ref in `refs` (the parent
//                                          draws pins in its OWN layer, over the
//                                          iframe -- unchanged, see
//                                          src/render.mjs's `pageDomPinLayer`
//                                          equivalent for the stage,
//                                          `pin-layer` in `.stage-wrap` below --
//                                          so it needs the stage to report
//                                          geometry rather than ever reaching
//                                          in for it itself). Sent once a stage
//                                          announces itself 'ready' (covers the
//                                          initial paint, including a read-only
//                                          archive's already-resolved pins) and
//                                          again whenever src/ui.mjs's
//                                          `refreshPins` runs (resize, a comment
//                                          queued, a submit landing).
//
// NO 'select' MESSAGE, DELIBERATELY (choose-between-rendered-variants). An earlier version of this widget had
// the stage post an unconditional, content-free 'select' on every click, so
// clicking the visible mock content of an html-kind OPTION -- not just the
// card's own chrome outside the iframe -- could pick that option; the parent
// acted on it whenever the frame sat inside a '.choice-variant' card. Reverted
// (before this ticket merged): every message on this channel is
// STAGE-AUTHORED input, no different in kind from the mock's own HTML or the
// agent's own script inside it -- and unlike 'click'/'hover' (which only ever
// PROPOSE an anchor a human still has to submit) or 'positions' (pure
// geometry), a message that could pick an option is the agent handing itself
// the answer to its own question. Two paths made that concrete: the stage's
// OWN script could dispatch a click on itself (an autoplaying demo, an
// animation, a mock that clicks its own button) with no human involved at
// all, and separately -- since `cb: 'cb-stage'` is a fixed, documented public
// string and origin/identity validation only prove a message came from SOME
// live stage, never that a human acted on it -- any stage's own script could
// call `window.parent.postMessage({cb:'cb-stage', type:'select'}, '*')`
// directly, skipping stageAgentScript's click handling entirely. Guarding the
// message (an `ev.isTrusted` check, say) would have closed only the first
// path; the second forges the message itself, upstream of any such guard.
// Deleted instead of guarded: an option's stage is a THUMBNAIL to choose
// between, not a surface to operate, so it is rendered `pointer-events: none`
// inside a '.choice-variant' card (src/styles.mjs) -- a real, trusted click
// over the visible mock can then never reach the iframe at all, and lands on
// the card in the parent document instead, which already handles it (see
// renderVariantOption's own comment). See test/check-stage-isolation.mjs's
// own tests for this: a forged 'select'-shaped message from a live,
// correctly-addressed stage is inert, because there is no handler left to
// act on it.
//
// ORIGIN VALIDATION -- an opaque-origin `srcdoc` frame has no real origin to
// check against, so "just compare to our own origin" (the usual same-origin
// check) is meaningless here. What each side actually validates, and why it is
// correct:
//
//   - PARENT reading a STAGE message (src/ui.mjs): `event.origin === 'null'`.
//     Dropping `allow-same-origin` makes the stage's browsing context opaque,
//     and the HTML living standard serializes an opaque origin, in a
//     `postMessage` event, as the literal four-character string `"null"` --
//     always, regardless of what URL/port the PARENT page itself is served
//     from (a live `http://127.0.0.1:<port>` or a `file://` archive). That is
//     not "an origin we happen to trust", it is the ABSENCE of an origin: any
//     message from anywhere else on the web (a browser extension, devtools, a
//     same-origin script the reviewer runs in the SAME tab -- which would carry
//     the page's real origin, not "null") is rejected by this check alone,
//     before any shape/identity check even runs. It is necessary but not
//     sufficient on its own (see identity, next) -- there is nothing else in
//     this browsing context that could ever produce a "null"-origin message
//     other than one of this page's OWN sandboxed stages, but nothing here yet
//     says WHICH one.
//   - PARENT identity check: `event.source` must equal the `contentWindow` of a
//     currently-mounted `.html-stage` frame -- not just "some opaque-origin
//     frame", but a SPECIFIC one this page actually rendered.  `event.source`
//     is a value the browser itself stamps on the event from the calling
//     script's actual global object; no page script anywhere can forge it (it
//     is not read off `event.data`, which IS attacker-controlled). Re-deriving
//     "which stage" by walking the live DOM at message-receive time, rather
//     than trusting an id the message claims for itself, is what makes this
//     the frame the parent actually thinks it is.
//   - STAGE reading a PARENT message (this script, below): `event.source ===
//     window.parent`. The stage has no reliable way to know the PARENT's real
//     origin in advance (the page can be served from any port, or opened as
//     `file://`), so an origin STRING check is not available to it the way it
//     is to the parent -- but it does not need one: `window.parent` is a
//     reference the browser hands this script once, at frame-creation time,
//     and (like `event.source` above) no script running in ANY window can make
//     `event.source` equal a DIFFERENT window's `window.parent` reference by
//     forging data. Identity alone is sufficient and correct here; there is no
//     meaningful second origin string to also check.
//
// SHAPE VALIDATION. Every handler on both sides checks every field's type
// before using it -- `typeof x === 'string'`, `Array.isArray`, `Number.isFinite`
// -- and drops anything that doesn't match rather than throwing or coercing. In
// particular the PARENT never evaluates, renders as HTML, or otherwise trusts a
// string FROM the stage: a hint is composed server-recognisable-safe from
// `tag`/`text` via the same `buildHint`/`composeHint` every other click already
// used (never `innerHTML`), and every anchor field lands in the comment form via
// `setAttribute`/`textContent` (src/ui.mjs's `openCommentForm`, unchanged), never
// string-concatenated into markup. See test/check-stage-isolation.mjs and
// test/check-click.mjs's malformed/hostile-message cases for the ablations this
// reasoning is checked against.

/** The stage-side half of the postMessage protocol above, inlined into every
 * html block's `srcdoc` (see renderHtmlBlock below), alongside whatever the
 * mock itself supplies. `buildSteps`/`stepsToPath`/`pathToSteps`/`resolveSteps`
 * are embedded via `.toString()` -- the exact same binding technique
 * src/ui.mjs already uses for `composeHint` (see that file's own comment on
 * why: dependency-free pure functions can be spliced in verbatim rather than
 * hand-copied a second time, which is what "single-source discipline"
 * requires here). Placed AFTER the mock's own
 * markup in the `srcdoc` string (renderHtmlBlock, below) rather than before
 * it: every listener here is attached to `document.body` itself (delegation),
 * which needs `document.body` to already exist and works regardless of
 * whether the mock's own content was added before or after this script runs --
 * see test/dom-stand-in.mjs's `runInlineScripts` for why this placement
 * matters for a real browser, not just this stand-in. */
// Exported so test/check-pure.mjs and test/check-stage-isolation.mjs
// can inspect and execute this exact string -- the same reason `ui` is exported
// from src/ui.mjs. Behavioural checks (test/check-click.mjs and friends) already
// run it for real, inside a rendered board's srcdoc, through test/dom-stand-in.mjs;
// this export is what lets a check assert STRUCTURAL properties of the one real
// copy (e.g. "the hover style is injected lazily, gated on comment mode actually
// turning on") without parsing it back out of a rendered page's escaped HTML
// attribute.

/** The stage's hover-highlight color -- a literal hex, deliberately NOT a CSS
 * custom property. This srcdoc document is sandboxed and its stylesheet
 * (ensureHoverStyle, below) is the one this file's header comment and
 * QUIRKS.md ("Two stylesheets, one palette") describe as never reachable from
 * the page's own tokens -- but a custom property is exactly the mechanism
 * that WOULD reach through that isolation regardless: custom properties
 * inherit, so any ancestor in agent-authored HTML that itself declares
 * `--accent` (its own brand color, or deliberately) wins over a `:root`
 * rule in this same document, with no specificity contest -- `!important`
 * on `outline` protects the `outline` declaration, not the `var()` it
 * substitutes. Measured in real Chrome: a
 * block under `style="--accent: transparent"` rendered the hover outline
 * `rgba(0, 0, 0, 0)` -- invisible -- and this outline is the ONLY
 * per-element targeting feedback the stage gives, so a reviewer could be led
 * to anchor a comment to an element they never saw highlighted. A literal is
 * the one value untrusted content in the same document cannot override.
 * This file's stage stylesheet is
 * exempt from the "no raw literal outside a token block" rule for exactly
 * this reason -- see test/check-pure.mjs, which asserts the isolation
 * property this comment describes (no custom property at all) rather than
 * merely "some hex is present".
 *
 * Pinned to --accent's LIGHT value, which is not a typo and not the palette
 * this file's document belongs to. The stage renders on `--stage-bg`, and
 * that token is now TWO values (src/styles.mjs): a neutral artboard per
 * palette, '#c3c6cd' dark and '#e6e8ee' light, since a mock owns its own
 * background and this surface is only what shows through one that paints
 * none. So the old justification for one literal ("the stage is white in both
 * palettes, so this outline is theme-independent") is gone -- what replaces it
 * is arithmetic, not a premise: both artboards are light neutrals (they have
 * to be, a srcdoc that paints no background renders the UA's BLACK text on
 * them), and one mid-blue clears the 3:1 WCAG floor for non-text UI on both.
 * The light accent measures 3.89:1 on the dark palette's artboard and 5.43:1
 * on the light one; the DARK accent measures 1.52:1 and 2.13:1, i.e. the same
 * colour that used to sit at 2.61:1 on white is still the wrong one, and now
 * fails on both surfaces rather than on one. Two hexes plumbed through the
 * parent's 'mode' postMessage would also work and remains
 * open; one literal that clears the bar on both is less machinery, and the
 * surfaces were chosen far enough apart in luminance to leave it room.
 * test/check-pure.mjs asserts the premise (the two --stage-bg values differ,
 * per palette), the requirement (contrast >= 3:1 against EACH of them) and the
 * drift guard (equality with --accent's light value) separately, so a palette
 * change that breaks any one of the three fails on the one it broke. */
export const STAGE_ACCENT_HEX = '#3251c9';

export function stageAgentScript() {
  return `<script>(function () {
  var CB = 'cb-stage';
  var HOVER_CLASS = 'cb-anchor-hover';
  // Applied instead of HOVER_CLASS to
  // an element whose own ref is already in 'sentRefs' below -- the stage-side
  // half of the same de-affordance src/ui.mjs applies page-side via its own
  // .cb-anchor-sent (same class name, by the convention QUIRKS.md "Two
  // stylesheets, one palette" already documents for HOVER_CLASS -- two
  // separate documents, one name).
  var SENT_CLASS = 'cb-anchor-sent';
  var commentMode = false;
  var hovered = null;
  var styleInjected = false;
  // The dom refs (this block's own, index-chain form -- stepsToPath's output)
  // that already carry a SENT comment, as told by the parent's 'mode' message
  // below. The stage cannot know this on its own: 'sent' is a fact about
  // board.comments, which lives only in the parent document (the stage's
  // isolation -- this document never sees the board JSON at all).
  var sentRefs = [];

  var buildSteps = ${buildSteps.toString()};
  var stepsToPath = ${stepsToPath.toString()};
  var pathToSteps = ${pathToSteps.toString()};
  var resolveSteps = ${resolveSteps.toString()};

  function post(msg) {
    try {
      var out = { cb: CB };
      for (var k in msg) if (Object.prototype.hasOwnProperty.call(msg, k)) out[k] = msg[k];
      window.parent.postMessage(out, '*');
    } catch (e) { /* no parent reachable -- nothing to anchor to */ }
  }

  // Discoverability CSS, applied inside THIS document only -- see QUIRKS.md
  // "Two stylesheets, one palette": the outer page's tokens deliberately do
  // not reach in here (isolation is the point), so this injected stylesheet
  // is a literal hex (STAGE_ACCENT_HEX's own comment, above, explains why a
  // custom property would defeat that isolation rather than merely being
  // redundant with it, and why it tracks --accent's LIGHT value: the stage's
  // artboard is a light neutral in BOTH palettes -- two different ones -- and
  // this one hex clears 3:1 on each). Injected
  // LAZILY (only once comment mode has
  // genuinely turned on at least once) rather than unconditionally at script
  // start -- a read-only archive never sends 'mode' with commentMode true at
  // all, so its stage document never gains this stylesheet, matching this
  // ticket's unchanged behavioural contract (test/check-archive.mjs: "no
  // hover stylesheet is even injected" in a read-only archive).
  function ensureHoverStyle() {
    if (styleInjected) return;
    styleInjected = true;
    try {
      var style = document.createElement('style');
      // A SENT_CLASS rule alongside the
      // ordinary hover one. The hover rule's colour is STAGE_ACCENT_HEX, kept in
      // step with src/styles.mjs by hand (QUIRKS.md "Two stylesheets, one
      // palette") because this stylesheet cannot reach the page's tokens -- one
      // value for both palettes, since it clears 3:1 on either artboard; the
      // SENT_CLASS rule needs no colour of its own, only a cursor, so it adds
      // nothing new to keep in step. No outline at all (not even 'none' -- there
      // is simply no rule adding one), so an already-sent element reads as inert
      // rather than as a differently-styled target.
      style.textContent = '.' + HOVER_CLASS + ' { outline: 2px solid ${STAGE_ACCENT_HEX} !important; outline-offset: 2px; cursor: pointer !important; } '
        + '.' + SENT_CLASS + ' { cursor: not-allowed !important; } '
        + 'body { cursor: default; }';
      (document.head || document.body).appendChild(style);
    } catch (e) { /* no hover highlight; the click below still anchors */ }
  }

  function clearHover() {
    if (hovered && hovered.classList) {
      hovered.classList.remove(HOVER_CLASS);
      hovered.classList.remove(SENT_CLASS);
    }
    hovered = null;
  }

  document.body.addEventListener('mouseover', function (ev) {
    if (!commentMode) return;
    var el = ev.target;
    clearHover();
    if (!el || el.nodeType !== 1 || el === document.body || !el.classList) return;
    hovered = el;
    var steps = buildSteps(document.body, el);
    var ref = (steps && steps.length) ? stepsToPath(steps) : null;
    // An element whose own ref already carries a SENT comment is
    // de-affordanced (SENT_CLASS) instead of marked as an ordinary target
    // (HOVER_CLASS). This is the VISIBILITY half only -- the click handler
    // below still posts 'click' unconditionally, exactly as before; "clicking
    // it does nothing" is already enforced on the other side of the channel
    // (src/ui.mjs's handleStageClick calls isSentAnchor before ever opening a
    // form), which is the side that actually holds board.comments and can
    // tell a resolved sent comment from a stale ref this document has no way
    // to distinguish on its own.
    if (ref !== null && sentRefs.indexOf(ref) !== -1) {
      hovered.classList.add(SENT_CLASS);
    } else {
      hovered.classList.add(HOVER_CLASS);
    }
    post({ type: 'hover', ref: ref, tag: el.tagName, text: el.textContent });
  });
  document.body.addEventListener('mouseout', function () {
    clearHover();
    post({ type: 'hover', ref: null, tag: null, text: null });
  });

  document.body.addEventListener('click', function (ev) {
    if (!commentMode) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || el === document.body) return;
    var steps = buildSteps(document.body, el);
    if (!steps || !steps.length) return;
    clearHover();
    post({ type: 'click', ref: stepsToPath(steps), tag: el.tagName, text: el.textContent });
  });

  function resolveRef(ref) {
    var steps = pathToSteps(ref);
    if (!steps.length) return null;
    return resolveSteps(document.body, steps);
  }

  // This document is the only thing that can
  // ever know its own rendered height -- the parent cannot reach
  // 'contentDocument' at all (see this file's own "ORIGIN VALIDATION" design
  // comment, above stageAgentScript, for why the frame is opaque by design),
  // so the stage measures and reports over this same channel, the same shape
  // as 'hover'/'positions' already use, rather than the parent ever trying to
  // reach in for it. Every html stage sends this, standalone or nested inside
  // a '.choice-variant' card -- renderHtmlBlock/stageAgentScript are the same
  // function either way, and this script has no way to know which kind of
  // card it ended up in -- so src/ui.mjs is the one that decides whether a
  // report is acted on. 'document.body.scrollHeight', not
  // 'document.documentElement''s: a mock supplied by value (renderHtmlBlock)
  // is exactly the fragment that lands in this document's '<body>', same as
  // every 'dom' ref this script already mints is rooted at 'document.body',
  // not the synthetic '<html>' wrapper around it.
  //
  // WHEN this runs matters as much as WHAT it reads, and got it wrong on the
  // first cut: calling this synchronously (here, at script scope) measures
  // BEFORE this document has ever been through a layout pass. Measured
  // directly in real Chrome (a throwaway probe frame outside this repo,
  // QUIRKS.md's "Preview harness"): inside a sandboxed srcdoc frame with no
  // allow-same-origin, 'document.body.scrollHeight' reads 0 not only
  // synchronously but at 'DOMContentLoaded', at 'load', and even a
  // zero-delay 'setTimeout' -- there is no external subresource for 'load' to
  // wait for, so it fires before this frame ever gets a rendering
  // opportunity. See reportHeightAfterLayout, below, for where the real first
  // call comes from; this function itself stays the plain, unconditional
  // measure-and-post -- ResizeObserver (below) also calls it directly, once a
  // real layout pass has actually happened.
  function reportHeight() {
    post({ type: 'height', height: document.body ? document.body.scrollHeight : 0 });
  }

  // requestAnimationFrame's callback runs as part of the SAME per-frame
  // "update the rendering" step that performs style/layout for this document
  // -- nested twice is the standard idiom for "wait until layout has
  // genuinely settled": a single rAF can still land on the frame that
  // establishes this document's first rendering opportunity, before that
  // opportunity's own layout has run, so by the time the SECOND callback
  // fires, at least one full rendering update is guaranteed complete. This is
  // the fix for the timing measured above -- 'load' doesn't tell you layout
  // happened, rAF does. Guarded exactly like ResizeObserver below (absent
  // from the DOM stand-in, QUIRKS.md "The stand-in has no layout"), and
  // requested unconditionally at script start regardless of this document's
  // current visibility: a real browser does not drop an outstanding
  // requestAnimationFrame request while its page is hidden, only slows its
  // cadence, so a stage opened into a background tab (a link opened while
  // reading something else, say) still gets a correct report the moment it
  // is actually looked at, with no separate visibilitychange plumbing
  // needed. Until either this or ResizeObserver's own first delivery lands,
  // src/styles.mjs's own starting height for a variant option's stage is the
  // fallback -- see that rule's own comment for why it is pinned at the same
  // 320px the fixed floor this feature replaces used, not lower.
  function reportHeightAfterLayout() {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(function () { requestAnimationFrame(reportHeight); });
  }

  // --- scroll, the one thing the parent genuinely cannot see -----------------
  //
  // ADR.md entry 40: on a page board the DOCUMENT does not scroll at all -- the
  // artifact scrolls inside this frame -- and this frame is an opaque-origin
  // browsing context, so the parent can neither read a scrollTop from it nor
  // observe one with an IntersectionObserver of its own. That is why scroll
  // state is a thing agent-authored markup REPORTS, over the same channel
  // 'height'/'click'/'hover' already use, and therefore gets the same shape
  // check on arrival as everything else on it (src/ui.mjs's listener).
  //
  // ONE type, both directions, which is what keeps entry 40's "one more message
  // type" literally true: outbound this says "I am at this offset", inbound
  // (the handler below) it says "put me at this offset" -- the back-to-top
  // control's whole mechanism, since the parent cannot scroll this document
  // either. 'top' is a plain number in both directions and is validated as one
  // on both sides.
  //
  // A real scroll listener, deliberately: the no-scroll-handler rule (ADR.md
  // entry 27, src/badge.mjs) is a rule about the BOARD page, where an
  // IntersectionObserver can see everything a scroll handler could. Nothing can
  // observe this document from outside it, so the listener lives here, in the
  // one place that can see the fact. Deduplicated on the last reported value,
  // so a scroll that ends where it began posts nothing; within a gesture the
  // cadence is one message per scroll event, same as any native handler.
  //
  // WHICH ELEMENT SCROLLS IS NOT KNOWABLE UP FRONT, and assuming it is the
  // document was a real defect, measured in Chrome 151 against an app-shell
  // artifact (a fixed sidebar beside a 'height: 100vh; overflow-y: auto' pane,
  // an ordinary shape for a page designed as a page). There the document never
  // scrolls at all: 'window.scrollY' stays 0 while the frame visibly shows the
  // third section, no 'scroll' event ever reaches 'window', so no report was
  // ever sent -- the header never condensed and the back-to-top control never
  // appeared -- and an inbound request moved nothing, because 'window.scrollTo'
  // does not touch an inner pane. Read, write and listener all have to name the
  // SAME element, and none of them can name it in advance.
  //
  // So the element identifies ITSELF, by scrolling. A capture-phase listener on
  // 'document' sees a scroll of any element (a scroll event on an element does
  // not bubble, but capture still walks down to it) as well as the viewport's
  // own, and 'ev.target' IS the thing that moved. That target is remembered and
  // is thereafter what gets read and what gets written -- correct by
  // construction rather than by a heuristic scan for scrollable boxes.
  //
  // The ordering makes this airtight for the inbound direction too: back-to-top
  // is only ever VISIBLE after a report, a report only ever follows a scroll
  // event, and the scroll event is what sets 'scroller'. The control cannot be
  // clicked before the scroller is known.
  //
  // ponytail: the most recently scrolled element wins. An artifact with two
  // independent scrolling panes reports whichever the reviewer touched last,
  // which is the one they are reading; the upgrade path, if a real artifact
  // ever needs it, is to report the target's own ref alongside the offset.
  var lastScrollTop = -1;
  var scroller = null; // null means "this document's viewport"

  function isViewportTarget(t) {
    return !t || t === document || t === window
      || t === document.documentElement || t === document.body;
  }

  function scrollTopNow() {
    if (scroller) return scroller.scrollTop;
    if (typeof window.pageYOffset === 'number') return window.pageYOffset;
    var el = document.scrollingElement || document.documentElement || document.body;
    return (el && typeof el.scrollTop === 'number') ? el.scrollTop : 0;
  }

  function reportScroll() {
    var top = scrollTopNow();
    if (top === lastScrollTop) return;
    lastScrollTop = top;
    post({ type: 'scroll', top: top });
  }

  function onScroll(ev) {
    scroller = isViewportTarget(ev.target) ? null : ev.target;
    reportScroll();
  }

  /** Put this document at 'top' -- the inbound half of the one message type.
   * Aimed at whatever last scrolled (see above), never at the viewport by
   * assumption. Feature-detected rather than try/caught into: a 'scrollTo' that
   * silently does nothing never throws, so a catch block is no guard at all
   * against the case this function exists to fix -- the catch below is only for
   * a browser that has 'scrollTo' but rejects the options object, and
   * 'scrollTop' is the floor under both. */
  function scrollTo(top) {
    var target = scroller || window;
    if (typeof target.scrollTo === 'function') {
      try {
        target.scrollTo({ top: top, left: 0, behavior: 'smooth' });
        return;
      } catch (e) { /* older two-argument signature only; fall through */ }
      target.scrollTo(0, top);
      return;
    }
    if (scroller) scroller.scrollTop = top;
  }

  // ADR.md entry 39: the board's theme control paints this document too, so a
  // rendered artifact needs none of its own. The parent resolves its own
  // three-state control (light / dark / the attribute's ABSENCE, meaning
  // System) down to a concrete 'light' or 'dark' before sending -- see
  // src/ui.mjs's activeTheme -- so this side never queries a media it would
  // then have to re-query on every OS flip. 'data-theme' on <html> is the same
  // attribute src/styles.mjs keys the board's own palette off, so a template
  // that already themes itself needs no new vocabulary; 'color-scheme' is set
  // beside it so an artifact that knows nothing about the attribute still gets
  // its scrollbars, form controls and canvas default from the right palette.
  function applyTheme(theme) {
    var root = document.documentElement;
    if (!root) return;
    try {
      root.setAttribute('data-theme', theme);
      if (root.style) root.style.colorScheme = theme;
    } catch (e) { /* nothing to theme; the artifact keeps its own colours */ }
  }

  window.addEventListener('message', function (ev) {
    // See this file's design comment above ("ORIGIN VALIDATION") for why
    // identity, not an origin string, is the correct and sufficient check on
    // this side of the channel.
    if (ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || typeof data !== 'object' || data.cb !== CB || typeof data.type !== 'string') return;
    if (data.type === 'mode') {
      commentMode = !!data.commentMode;
      // 'sentRefs' widens this message (still 'mode',
      // not a new type -- sent-ness is exactly the kind of fact that matters
      // precisely when mode changes). Shape-checked like every other field this
      // channel carries: an absent or malformed list leaves 'sentRefs'
      // whatever it already was, rather than guessing or throwing, and a
      // non-string entry is dropped rather than compared against later.
      if (Array.isArray(data.sentRefs)) {
        sentRefs = data.sentRefs.filter(function (r) { return typeof r === 'string'; });
      }
      // 'theme' widens this message the same way 'sentRefs' above already does
      // (ADR.md entry 39 -- "over the channel that already carries comment
      // mode"), rather than minting a type of its own: same tolerance, same
      // convention. An absent or unrecognised value leaves this document's
      // theme exactly as it was, so a stage that is never told stays on
      // whatever its own markup chose.
      if (data.theme === 'light' || data.theme === 'dark') applyTheme(data.theme);
      if (commentMode) ensureHoverStyle(); else clearHover();
      return;
    }
    if (data.type === 'scroll') {
      // The inbound half of the one type (see reportScroll above): the parent's
      // back-to-top control asking this document to go somewhere, since it
      // cannot scroll this document itself. Shape-checked before it reaches
      // anything -- a non-finite 'top' is exactly the kind of value that would
      // otherwise be handed to scrollTo.
      if (typeof data.top !== 'number' || !isFinite(data.top)) return;
      scrollTo(data.top);
      return;
    }
    if (data.type === 'locate') {
      if (typeof data.requestId !== 'string' || !Array.isArray(data.refs)) return;
      var positions = {};
      var bodyBox = document.body.getBoundingClientRect ? document.body.getBoundingClientRect() : null;
      for (var i = 0; i < data.refs.length; i++) {
        var ref = data.refs[i];
        if (typeof ref !== 'string') continue;
        var el = resolveRef(ref);
        if (el && bodyBox && el.getBoundingClientRect) {
          var box = el.getBoundingClientRect();
          positions[ref] = { left: box.left - bodyBox.left, top: box.top - bodyBox.top };
        } else {
          positions[ref] = null;
        }
      }
      post({ type: 'positions', requestId: data.requestId, positions: positions });
      return;
    }
  });

  reportHeightAfterLayout();
  // Keeps the report tracking a mock whose content changes size AFTER first
  // paint (an image loading in, a toggle revealing more copy) -- guarded
  // exactly the way src/ui.mjs's setupRoundObserver guards
  // 'IntersectionObserver' (QUIRKS.md "The stand-in has no layout"): this
  // repo's DOM stand-in defines neither this nor requestAnimationFrame, so
  // neither the first, layout-deferred report nor a later resize-driven one
  // is directly exerciseable there -- see QUIRKS.md's new entry on this
  // feature's own measurement for what that leaves untestable, and
  // test/check-pure.mjs's stubbed requestAnimationFrame for how far the
  // stand-in check goes anyway (the real entry point, not a fabricated
  // scrollHeight fed straight into reportHeight).
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  // Capture phase, on 'document', is what makes this one listener see BOTH the
  // viewport's own scroll and an inner pane's -- an element's scroll event does
  // not bubble, so a plain 'window' listener is blind to exactly the artifact
  // shape that broke this (see onScroll's own comment above).
  document.addEventListener('scroll', onScroll, true);
  post({ type: 'ready' });
})();</script>`;
}

/** Prepended to every html-stage `srcdoc` (renderHtmlBlock, below) to kill the
 * UA default `body { margin: 8px }` gutter -- see that function's own comment
 * for why this is a bare leading `<style>` and not an explicit document
 * wrapper. Exported (same reasoning as STAGE_ACCENT_HEX above) so a check can
 * assert against this exact string rather than a hand-copied guess at it. */
export const STAGE_MARGIN_RESET = '<style>html,body{margin:0;padding:0}</style>';

/** A raw HTML stage, for hand-mocked UI previews with no source file — the one
 * context kind passed by value (see PROTOCOL.md Blocks). Rendered inside a
 * sandboxed iframe so the mock's own markup/CSS/script never leaks into or
 * clashes with the board page — including its SCRIPT, not merely its CSS and
 * markup, since `allow-same-origin` was dropped (see the design comment
 * above): the frame's browsing context is now genuinely cross-origin from the
 * daemon's own, so `contentDocument`/`contentWindow.document` are unreachable
 * from the parent, and element-level click-to-comment goes over the
 * `stageAgentScript` postMessage channel instead. `pin-layer` is an empty,
 * absolutely positioned sibling over the iframe that src/ui.mjs populates with
 * numbered pins for `dom` anchors, positioned from geometry the stage itself
 * reports (never written to here, since that needs a real, live DOM). */
/** The `srcdoc` every html stage gets, whole-block or nested in a question's
 * context (renderContextInner, below) alike: the margin reset, the mock's own
 * markup, then the stage-side agent script -- one construction, so the two
 * call sites can never drift apart on what a stage actually is. */
function buildStageSrcdoc(block) {
  return STAGE_MARGIN_RESET + block.html + stageAgentScript();
}

/** The awaited page's own send control (SPEC_AWAITED.md ticket 03; ADR.md
 * entries 45, 46, 48, 49). `.page-comments` (renderHtmlBlock's fullpage branch,
 * below) carries an entirely different surface depending on whether `round` is
 * *awaited* right now (CONTEXT.md), computed by `roundIsCurrentlyAwaited`
 * (src/badge.mjs) against `nowMs` -- the SAME predicate the header pill reads,
 * so the two can never disagree about whether this page can be commented on:
 *
 *   - never awaited at all, sent, timed out, or expired mid-wait (AC 8, AC 11's
 *     fallback, AC 12): no compose form, no hint, no send control -- only
 *     whatever comments are already on record for this block, rendered exactly
 *     as `commentArea` renders them for any other block. The `comment-list` div
 *     is still emitted even empty: a comment queued CLIENT-SIDE the instant
 *     before a wait died has nowhere else to keep rendering ("comments already
 *     left stay on screen", AC 12), and src/ui.mjs's refreshPins looks this id
 *     up by the same convention every block's list uses.
 *   - open and awaited, short of its deadline: the live surface -- the ADR 48
 *     hint line while the list is empty (teaching the click-to-comment gesture,
 *     since comment mode already starts ON here and the toggle itself is no
 *     longer what reveals the gesture), the compose form, the list, and the
 *     send control labelled for exactly what it will send ("Nothing to add" at
 *     zero, "Send N comments" above it, AC 4) with Discuss beside it.
 *   - sent: the same live markup as the open case, `historical` true -- the
 *     identical treatment `commentArea` already gives every other block's form
 *     once its round has gone out ("read-only like any other sent round", this
 *     ticket's own Testing section), rather than a third shape to keep in sync.
 *
 * `round` can in principle be missing (a block whose round record vanished);
 * treated as closed rather than thrown on, the same defensive default AC 8's
 * "never awaited" gets from `roundIsAwaitedOpen`'s own `!!round` guard.
 *
 * `open` here means `roundIsAwaitedOpen` (src/badge.mjs) alone -- status and
 * `awaited`, nothing else -- deliberately NOT `roundIsCurrentlyAwaited`'s
 * stricter "and the deadline hasn't passed yet": that third fact needs a wall
 * clock, and this function has to stay a pure one of the board JSON (see
 * badge.mjs's own header comment on the split). An open, awaited round whose
 * deadline already lapsed therefore still renders the LIVE surface here; the
 * live downgrade to the closed one the instant that becomes true happens
 * entirely in src/ui.mjs, before the reader can act on the stale form (AC 12). */
function renderPageCommentPanel(block, round, commentsByBlock) {
  const blockId = block.id;
  const sent = !!round && round.status === 'sent';
  const open = roundIsAwaitedOpen(round);
  if (!sent && !open) {
    return `<div class="comment-list" id="comment-list-${escAttr(blockId)}">${commentItemsHtml(blockId, commentsByBlock)}</div>`;
  }
  const historical = sent;
  const count = (commentsByBlock.get(blockId) || []).length;
  const label = count === 0 ? 'Nothing to add' : `Send ${count} comment${count === 1 ? '' : 's'}`;
  // Rendered INSIDE the send bar, at its left end (src/styles.mjs): the hint is
  // one short line and the bar's own row had room for it, so a row of its own
  // was a row of panel height spent on nothing. src/ui.mjs finds it through the
  // panel rather than through a parent, so its home here is a layout fact only.
  //
  // Moving it there did cost one thing, and `aria-describedby` below is what
  // buys it back: the hint used to be the panel's FIRST child, so a screen
  // reader met "click anywhere on the page to leave a comment" before the
  // compose input. It is now the last row, announced after the input it
  // explains and between Discuss and Send. Pointing the input at it restores
  // the pairing without moving the box back: the instruction is read as the
  // field's own description, wherever it sits on screen.
  const hintId = `page-comment-hint-${escAttr(blockId)}`;
  const showHint = open && count === 0;
  const hint = showHint
    ? `<p class="page-comment-hint" id="${hintId}">Click anywhere on the page to leave a comment.</p>`
    : '';
  return `
    <div class="comment-target" id="comment-target-${escAttr(blockId)}">commenting on: whole block</div>
    <form class="comment-form" id="comment-form-${escAttr(blockId)}" data-block-id="${escAttr(blockId)}" data-anchor-kind="block">
      <input type="text" placeholder="Add a comment"${showHint ? ` aria-describedby="${hintId}"` : ''}${historical ? ' disabled' : ''}>
      <button type="submit"${historical ? ' disabled' : ''}>Add</button>
    </form>
    <div class="comment-list-wrap"><div class="comment-list" id="comment-list-${escAttr(blockId)}">${commentItemsHtml(blockId, commentsByBlock)}</div></div>
    <div class="page-send-bar" data-round="${round.n}">
      ${hint}
      <button type="button" class="btn-discuss page-discuss-btn" data-round="${round.n}"${historical ? ' disabled' : ''}>Discuss in chat</button>
      <button type="button" class="btn-send page-send-btn" data-round="${round.n}"${historical ? ' disabled' : ''}>${escHtml(label)}</button>
    </div>`;
}

/** `fullpage`: this stage is the whole board (ADR.md entry 33), so it renders
 * with no kicker at all and its comment surface floats over the frame instead of
 * sitting under it. What does NOT change is everything the stage gesture is
 * built on: the same `.block.html-block` section carrying the same
 * `data-block-id`, the same `.stage-wrap` > `.html-stage` + `.pin-layer`
 * nesting, and the same `srcdoc` bytes. src/ui.mjs's message listener finds a
 * stage's block by `frame.closest('.html-block')` and its pin layer by
 * `section.querySelector('.pin-layer')` — markup that dropped either would kill
 * click-to-anchor, hover and pin placement on exactly the boards this layout
 * exists for, and would do it silently (every stage message would simply be
 * dropped at that lookup).
 *
 * The kicker's two controls go rather than being hidden, since neither holds any
 * state: the comment button mints a whole-block comment the click gesture inside
 * the frame already covers, and the expand control opens a lens that is a copy
 * of what already fills the viewport (ADR.md entry 43). The send bar is the
 * opposite case and is deliberately still emitted — see renderBoardPage. */
function renderHtmlBlock(block, board, commentsByBlock, historical, fullpage = false) {
  // A referenced source can fail to resolve (sliced
  // with lines/section, over the byte cap, or outside the confinement boundary) --
  // same block-level-error shape as renderMarkdownBlock/renderCodeBlock/
  // renderMermaidBlock, stage chrome dropped since there is nothing to stage.
  if (block.error) {
    return `
<section class="block html-block" data-block-id="${escAttr(block.id)}" data-block-kind="html">
  <div class="block-kicker">HTML stage ${commentButton(block.id)}</div>
  ${resolveErrorNote(block)}
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
  }
  // A referenced file's resolved text lands in `block.html` exactly where a
  // hand-mocked stage's by-value text always did (src/board.mjs's normalizeBlock),
  // so the srcdoc built here is the SAME for both -- nothing downstream of
  // resolution knows or cares whether the markup came from disk or the wire.
  //
  // STAGE_MARGIN_RESET (below) exists for exactly one reason: a bare fragment
  // `srcdoc` (no <html>/<head>/<body> of its own) still gets the UA default
  // `body { margin: 8px }`, which showed the frame's own background
  // (`--stage-bg`, `.html-stage` in src/styles.mjs) through an 8px gutter on
  // every side of every hand-authored mock. Its only job is the margin/padding
  // reset -- no color anywhere in it, so html/body stay transparent and the
  // parent-controlled `--stage-bg` still shows through wherever the mock
  // itself paints nothing.
  //
  // Deliberately a LEADING <style> tag, not an explicit <html><head>...</head>
  // <body>...</body></html> wrapper: a real browser only hoists a leading run
  // of head-only elements (HEAD_ONLY_TAGS -- style/script/meta/link/title/base)
  // out of `document.body` when the srcdoc is parsed as the bare fragment it
  // actually is (see src/anchor.mjs's own HEAD_ONLY_TAGS comment and the C2 fix
  // shipped for it). An explicit `<body>` opened before block.html's
  // own leading `<style>` (the ordinary case for a mock that styles itself --
  // see this function's own header comment) stops that hoist dead: once body
  // is genuinely, explicitly open, the HTML parsing algorithm inserts a
  // subsequent style/script tag as an ordinary CHILD of body instead of
  // reopening head for it, which shifts every `dom`-anchor ref index by one
  // and breaks exactly the mocks this exists to support (confirmed
  // against test/check-click.mjs's own C2 check, which fails hard on an
  // explicit-body wrapper here). A leading `<style>` has no such cost: it is
  // itself just the first element of that same leading head-only run, so it
  // hoists out of body right alongside a mock's own leading `<style>` (if any),
  // in encounter order, and a <style> element's rules apply wherever it ends
  // up in the tree regardless. block.html + stageAgentScript() still land in
  // exactly the same relative order as before, immediately after the reset --
  // this only prepends, it never moves the script.
  const srcdocContent = buildStageSrcdoc(block);
  if (fullpage) {
    const round = board.rounds.find(r => r.n === block.round);
    return `
<section class="block html-block" data-block-id="${escAttr(block.id)}" data-block-kind="html">
  <div class="stage-wrap">
    <iframe class="html-stage" sandbox="allow-scripts" srcdoc="${escAttr(srcdocContent)}"></iframe>
    <div class="pin-layer" data-block-id="${escAttr(block.id)}"></div>
  </div>
  <div class="page-comments">${renderPageCommentPanel(block, round, commentsByBlock)}</div>
</section>`;
  }
  return `
<section class="block html-block" data-block-id="${escAttr(block.id)}" data-block-kind="html">
  <div class="block-kicker">HTML stage ${commentButton(block.id)} ${expandButton(block.id, 'stage')}</div>
  <div class="stage-wrap">
    <iframe class="html-stage" sandbox="allow-scripts" srcdoc="${escAttr(srcdocContent)}"></iframe>
    <div class="pin-layer" data-block-id="${escAttr(block.id)}"></div>
  </div>
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
}

function renderCompareSide(side, board, commentsByBlock, historical) {
  const label = side && side.label ? side.label : '';
  const body = side && side.block
    ? renderBlock(side.block, board, commentsByBlock, historical)
    : '<p class="unsupported-widget">no content</p>';
  return `<div class="compare-side">
    <div class="compare-label">${escHtml(label)}</div>
    ${body}
  </div>`;
}

/** The side-by-side comparison stage inherited from /example, used whenever two
 * candidate designs exist. Each side is itself a content block (markdown/code/
 * mermaid/html), rendered through the same renderBlock dispatch, so a side holding
 * an `html` stage or a `mermaid` diagram keeps that kind's own comment affordance
 * here exactly as it has it anywhere else -- ADR.md entry 28 draws the rule on
 * kind, never on position. A side holding `markdown` or `code` has none, for the
 * same reason and just as positionally.
 *
 * No commentButton/commentArea/pageDomPinLayer on the wrapper itself (ADR
 * "Commenting is confined to content blocks", 2026-08-01): `compare` is a grid
 * around two nested blocks, not content of its own. This is a narrowing from
 * the earlier design this comment used to describe -- `.compare-side`'s
 * label and a side with no content block (`renderCompareSide`'s "no content"
 * fallback) were previously anchorable via a page-scoped pin-layer on this
 * outer section; that is an accepted, documented cost now (a comparison can no
 * longer be commented on as a whole, only one side or the other), not an
 * oversight -- there is nothing left on this wrapper that could ever populate
 * a pin here, so the layer itself would be permanently empty markup. */
function renderCompareBlock(block, board, commentsByBlock, historical) {
  return `
<section class="block compare-block" data-block-id="${escAttr(block.id)}" data-block-kind="compare">
  <div class="block-kicker">Compare</div>
  <div class="compare-grid">
    ${renderCompareSide(block.left, board, commentsByBlock, historical)}
    ${renderCompareSide(block.right, board, commentsByBlock, historical)}
  </div>
</section>`;
}

/** Dispatch by block kind. `historical` (default false) is true once the block's
 * round has been sent — see renderQuestionBlock for the answer widgets; every
 * other kind threads it into its own commentArea() too, so a sent round's comment
 * form goes inert along with its answers rather than staying a second, live place
 * to add to an exchange that already went out. Exported so
 * src/server.mjs can render a single block's fragment for an SSE amend push
 * without duplicating the dispatch.
 *
 * `fullpage` (default false) is the page-board layout (ADR.md entry 33), and
 * only `html` reads it — it is exactly "this stage IS the board", which no other
 * kind can ever be, since a board carrying anything else is not a page board at
 * all. Threaded rather than derived here: the shape rule is a property of the
 * BOARD (isPageBoard, below), and a block cannot see the board it sits in. */
export function renderBlock(block, board, commentsByBlock, historical = false, fullpage = false) {
  switch (block.kind) {
    case 'markdown': return renderMarkdownBlock(block);
    case 'question': return renderQuestionBlock(block, board, commentsByBlock, historical);
    case 'mermaid': return renderMermaidBlock(block, board, commentsByBlock, historical);
    case 'code': return renderCodeBlock(block);
    case 'html': return renderHtmlBlock(block, board, commentsByBlock, historical, fullpage);
    case 'compare': return renderCompareBlock(block, board, commentsByBlock, historical);
    default: return '';
  }
}

/** Groups comments ALREADY run through resolveComment (see renderBoardPage below)
 * by the block they attach to. Exported so src/server.mjs can build the same
 * grouping when rendering an SSE fragment as renderBoardPage uses for the full
 * page -- resolving once per render, here, rather than once per call site, is
 * what keeps a pin's resolved/lost styling and its block's comment-list entry
 * from ever disagreeing about the same comment (see this file's header comment). */
export function groupCommentsByBlock(resolvedComments) {
  const map = new Map();
  for (const resolved of resolvedComments) {
    if (!map.has(resolved.blockId)) map.set(resolved.blockId, []);
    map.get(resolved.blockId).push(resolved);
  }
  return map;
}

/** Render one round as a self-contained `<section class="round ...">`: its blocks
 * in board order, `round-open` while it's still live and editable, `round-history`
 * once it has been sent. A sent round's answers stay fully readable (prompt,
 * choice, note all come from board.answers exactly as the open-round path reads
 * them) but every widget renders `disabled` — see renderQuestionBlock — so it is
 * never a second, stale place to edit the same question. "A board is a
 * session-scoped thread with rounds": a sent round stays readable and stops being
 * editable. ADR.md entry 42 moved that from a history rail stacked under the open
 * round to a page of its own, and the pager keeps the guarantee (src/ui.mjs's
 * goToRound puts `sent-page` on <body> when a sent page is the one showing, which
 * is what reaches the send bar — the one control no round-scoped mechanism can).
 * Exported so this is also what
 * src/server.mjs renders for an SSE push of a brand-new round — the full page and a
 * live push produce byte-identical markup for the same round, which is what makes
 * a client that reconnects mid-thread indistinguishable from one that was there the
 * whole time. */
export function renderRoundSection(board, roundN, commentsByBlock) {
  const round = board.rounds.find(r => r.n === roundN);
  const historical = !!(round && round.status === 'sent');
  const blocksForRound = board.blocks.filter(b => b.round === roundN);
  // Both of these are DERIVED from the board rather than passed in, and that is
  // load-bearing: src/server.mjs renders an SSE push through this same function,
  // and a parameter the two callers could disagree about is exactly how the two
  // paths stop being byte-identical (test/check-pure.mjs pins that they are).
  //
  // fullpage: a round whose blocks are one rendered artifact and nothing else is
  // a page, filling the viewport (ADR.md entry 42 -- "a page-board round is one
  // page ...; a question round is another"). Per ROUND, not per board, since a
  // thread keeps its single board: the artifact stays a full-viewport page for
  // good, and the question round that follows it is an ordinary round on the
  // next page. current: the board opens on its newest round, so that is the one
  // page rendered visible at first paint (src/styles.mjs hides the rest).
  const fullpage = isPageRound(blocksForRound);
  const lastRound = board.rounds[board.rounds.length - 1];
  const current = !!lastRound && lastRound.n === roundN;
  const blocksHtml = blocksForRound.map(b => renderBlock(b, board, commentsByBlock, historical, fullpage)).join('\n');
  // The round's own title, when it has one (src/board.mjs stores it per round). A
  // thread routinely runs several rounds across several branches, and a rail of
  // identical "Round 1/2/3" headings tells the reviewer nothing about which is which.
  // Escaped as one string with the rest of the label, so a title carrying `<` is text.
  const title = (round && round.title) || '';
  const base = roundPageLabel(roundN, title);
  const label = historical ? `${base} · sent` : base;
  // An open round has a top (.round-label above) but used
  // to render nothing at all after its last block, so running out of scroll and
  // reaching the actual end read identically. This closes it with a rail naming the
  // round and its question count -- a sent round already gets its own "· sent" label
  // and history-rail treatment (below), so the end rail is for the open round only;
  // src/ui.mjs's markRoundHistory strips it back out the moment a round goes to
  // history live, so the two never disagree about which rounds carry one (QUIRKS.md
  // "the stylesheet and the markup are checked against each other" -- same discipline
  // applied to server markup vs. its live-transition twin). Question count is a plain
  // top-level count, matching what the send bar's own arming logic (src/ui.mjs) walks
  // -- a block nested in a question's context or a compare side is not one the
  // reviewer answers, so it isn't one of "how many questions it held" either.
  const questionCount = blocksForRound.filter(b => b.kind === 'question').length;
  const endTag = `end of round ${roundN} · ${questionCount} question${questionCount === 1 ? '' : 's'}`;
  const endRail = historical || fullpage ? '' : `
  <div class="round-end"><span class="line"></span><span class="tag">${escHtml(endTag)}</span><span class="line"></span></div>`;
  // An artifact round keeps its section (data-round is how a push, an amend and
  // the pager all find a round, and the section IS the page) and loses only its
  // two labels: the "Round N" chip and the closing rail are chrome ABOUT a
  // round, printed over a full-viewport artifact, and the pager at the bottom of
  // the page already names the round for anyone who needs it -- exactly the "no
  // card, no kicker" noise this layout exists to remove. The rail carries a
  // second meaning too (it is what docks the send bar), which a page with
  // nothing to send has no use for either.
  const roundLabel = fullpage ? '' : `
  <div class="round-label">${escHtml(label)}</div>`;
  return `
<section class="round ${historical ? 'round-history' : 'round-open'}${current ? ' round-current' : ''}" data-round="${roundN}" data-round-status="${historical ? 'sent' : 'open'}">${roundLabel}
  ${blocksHtml}
  ${endRail}
</section>`;
}

/** Render a complete, self-contained HTML page for `board`. Pure function of the
 * board JSON: same input, same output, every time. Blocks are grouped by round
 * (see renderRoundSection) rather than flattened, and each round is a PAGE of
 * this board (ADR.md entry 42): every round is rendered, exactly one carries
 * `round-current` and the stylesheet shows only that one, so a follow-up round
 * is a page flip away rather than a scroll away — "A board is
 * a session-scoped thread with rounds". Every comment is run through
 * resolveComment exactly once here (`resolvedComments`), and that single verdict
 * feeds both the server-rendered per-block comment list AND the `#board-data`
 * payload src/ui.mjs hydrates pins from — one source of truth for "does this
 * anchor still resolve", not two independently-computed ones that could disagree
 * (what went wrong when the client
 * re-derived resolved/lost itself against the live DOM/SVG). src/server.mjs's SSE
 * push payloads build `boardForClient` the same way, for the same reason — see
 * "SSE events" in PROTOCOL.md.
 *
 * The send bar carries BOTH ways out of a round ("Two
 * ways out, plus a wall clock"): `#send-btn` posts `action:'send'`, `#discuss-btn`
 * posts `action:'discuss'` with whatever is filled in right now — partial answers
 * are the point — and tells the agent to stop posting boards. Both live inside the
 * one `.send-bar`, which `body.readonly` hides wholesale (src/styles.mjs), so the
 * standalone file:// archive has neither. `#questions-left-pill` (ADR.md entry 27)
 * is nested inside the same `.send-bar` for exactly that reason: it inherits the
 * bar's readonly hiding for free rather than earning a second CSS rule, and it
 * leaves the bar's own last-child position in `.board-shell` untouched. It is
 * purely informational -- src/ui.mjs is what makes it live and click-navigable;
 * this function only ever renders its first-paint count and label.
 *
 * A page board offers none of THIS bar (ADR.md entry 44: "a page board is
 * never sent" through the ordinary send bar stays a browser rule, unchanged by
 * SPEC_AWAITED.md), and gets there the way body.readonly already does -- one
 * stylesheet rule, `body.page-board .send-bar { display: none; }`, not by
 * dropping the markup. For a board that never becomes awaited, or whose one
 * page round is not the newest, this bar is still the only route a queued
 * comment has off the page: a comment left there rides the next round's
 * submit, and that round arrives over SSE into THIS document as a new page,
 * which the reviewer flips to and sends from. Deleting the markup here would
 * mean a live round landing on a board with nothing to send it with, and the
 * reviewer's queued comments stranded with it. An AWAITED page round
 * (SPEC_AWAITED.md ticket 03) gains its own, second send control instead --
 * `.page-send-bar`, inside `.page-comments` itself (renderPageCommentPanel,
 * below), which posts to its OWN round rather than "the latest unsent one"
 * this bar always means. The two kickers' controls are a third, different
 * case and ARE dropped outright on a page round -- see renderHtmlBlock.
 *
 * A third rule hides it for a third reason: `body.sent-page .send-bar`. A sent
 * round is a page you can still flip back to, and it is read-only there (ADR.md
 * entry 42 -- the guarantee the deleted history rail used to carry). The bar's
 * own buttons sit OUTSIDE any round section, so nothing that disables a sent
 * round's widgets ever reaches them; src/ui.mjs's goToRound disables them too.
 *
 * `#back-to-top` (ADR.md entry 40) sits BESIDE the bar rather than inside it,
 * unlike `#questions-left-pill`: it has to survive `body.readonly .send-bar {
 * display: none }`, since an archived page board is exactly the case where the
 * artifact is still scrolled and still has to be scrollable back. It goes just
 * ABOVE the bar in source order rather than after it, because `.send-bar` being
 * `.board-shell`'s own last element child is what makes the shell's zero bottom
 * padding land the bar's lower edge on the document's (test/check-round-end.mjs
 * pins exactly that). Costs nothing: the control is `position: fixed`, so it is
 * out of flow and its source position decides only tab order. Emitted on every
 * board and turned on by src/ui.mjs's `.visible` class alone, which only ever
 * follows a scroll report from a page board's own stage — its `.back-to-top`
 * rule (src/styles.mjs) is what explains why bottom-RIGHT rather than the pill's
 * bottom-centre. */
/** Is there a round waiting to be answered? Decides whether the send bar is live at
 * HYDRATE time, which nothing used to: the buttons were rendered
 * enabled unconditionally and only ever disabled by an SSE push handler, so a finished
 * board opened from the index had a live Send. Pressing it posted `round: null`, which
 * the server answers 400 — not the 409 the client special-cases — so the page showed
 * `Error: submit failed: 400` and re-enabled the buttons, forever. */
function hasOpenRound(board) {
  const latest = board.rounds[board.rounds.length - 1];
  return Boolean(latest && latest.status === 'open');
}

/** The questions-left pill's own count (ADR.md entry
 * 27): how many of the OPEN round's top-level questions are still outstanding, at
 * the moment this page is rendered. Nothing is answered yet server-side while a
 * round is open -- answers only land in the store on submit ("Send is
 * never gated") -- so at render/reload time every one of the open round's questions
 * is unanswered by construction, and this is exactly renderRoundSection's own
 * `questionCount` for that round: the same top-level count src/ui.mjs's
 * outstandingBlocks() walks once the client script takes over. src/ui.mjs recomputes
 * this live as the reviewer answers; this is only ever the FIRST-PAINT value, before
 * any client script has run -- same division of labour as initialRoundInView below. */
function openRoundQuestionCount(board) {
  const latest = board.rounds[board.rounds.length - 1];
  if (!latest || latest.status !== 'open') return 0;
  return board.blocks.filter(b => b.round === latest.n && b.kind === 'question').length;
}

/** Is this board a PAGE board — one rendered artifact filling the viewport
 * rather than a stage sitting in a column? ADR.md entry 33: inferred from the
 * board's own shape, never declared. A board whose blocks are exactly one `html`
 * block and nothing else is one; anything else — a question, a second content
 * block, a later round — is an ordinary board. Nothing enters the protocol:
 * there is no `display` field and no new kind, and every content-only `html`
 * board already in the store re-renders as a page board retroactively.
 *
 * The rule itself is `isPageRound` (src/badge.mjs), because ADR.md entry 42
 * turned it into a question about a ROUND: board-level and round-level are the
 * same question asked of two block lists, and a single-round board and its one
 * round always answer identically. Re-exported here, where the checks and every
 * renderer already look for it; the client script asks the same function again
 * on every page flip. */
export { isPageRound };

export function isPageBoard(board) {
  return isPageRound((board && board.blocks) || []);
}

/** The board's pages, named, at the bottom of the page (ADR.md entry 42). Three
 * always-present controls, never two alternatives (criterion 26): the two edge
 * chevrons step one round, the pill in the middle names every round and jumps
 * straight to one. They are rendered here with their first-paint state already
 * correct -- current round, disabled ends, the dot on the round still owing an
 * answer -- so a board that opens on its newest round shows the right page with
 * no flash and no client script; src/ui.mjs's goToRound then owns all three.
 *
 * The chevrons are siblings of the pill rather than children of it, because
 * '.round-pager' carries a `transform` to centre itself and a transformed
 * ancestor becomes the containing block for `position: fixed` descendants --
 * chevrons nested inside would be pinned to the pill's box instead of the
 * viewport's edges.
 *
 * "Owes an answer" is a round that is not yet sent AND actually asks something:
 * the same rule the index badge counts by (ADR.md entry 25), so a page-board
 * round -- open forever, since nothing sends it -- is never dotted as though
 * the reviewer were holding it up. */
function roundOwesAnswer(board, round) {
  if (!round || round.status === 'sent') return false;
  return board.blocks.some(b => b.round === round.n && b.kind === 'question');
}

function roundPagerMarkup(board, currentN) {
  const rounds = board.rounds || [];
  const pages = rounds.map(r => {
    const classes = ['round-page'];
    if (r.n === currentN) classes.push('round-page-current');
    if (roundOwesAnswer(board, r)) classes.push('round-page-owed');
    // Bare numeral on the face; the round's full NAME is its accessible name and
    // its hover title, so neither a screen reader nor a mouse loses what the
    // caption below only ever says about the current round. See roundNumberLabel
    // (src/badge.mjs) for why a name stopped being printed on the face at all.
    const full = roundPageLabel(r.n, r.title || '');
    return `<button type="button" class="${classes.join(' ')}" data-round="${r.n}" title="${escAttr(full)}" aria-label="${escAttr(full)}"${r.n === currentN ? ' aria-current="page"' : ''}>${r.n}</button>`;
  }).join('');
  const first = rounds.length ? rounds[0].n : 1;
  const last = rounds.length ? rounds[rounds.length - 1].n : 1;
  const current = rounds.find(r => r.n === currentN);
  // The dock, not the pill, is the fixed and centred box: the caption has to sit
  // above the numerals and share their centre line, and stacking them inside one
  // fixed column is what keeps that true with no measured offset between them.
  // The chevrons stay OUTSIDE it for the reason they were already outside the
  // pill -- a transformed ancestor becomes the containing block for a fixed
  // descendant, which would pin them to this box instead of the viewport.
  return `  <button type="button" class="round-flip round-flip-prev" id="round-prev" aria-label="Previous round" title="Previous round"${currentN <= first ? ' disabled' : ''}>‹</button>
  <button type="button" class="round-flip round-flip-next" id="round-next" aria-label="Next round" title="Next round"${currentN >= last ? ' disabled' : ''}>›</button>
  <div class="round-pager-dock">
    <div class="round-pager-caption" id="round-pager-caption">${escHtml(roundPageLabel(currentN, (current && current.title) || ''))}</div>
    <nav class="round-pager" id="round-pager" aria-label="Rounds"><span class="round-pager-lede" aria-hidden="true">Rounds</span>${pages}</nav>
  </div>`;
}

export function renderBoardPage(board) {
  const resolvedComments = resolveComments(board, board.comments);
  const commentsByBlock = groupCommentsByBlock(resolvedComments);
  // The page-board layout (ADR.md entries 32, 33, 34) is carried two ways: down
  // into the round/block markup (no round label, no kicker -- renderRoundSection
  // decides that per round), and out onto <body> as a single class the whole
  // stylesheet keys off. One class rather than a per-element modifier because
  // what changes is the page's own geometry -- the shell stops being a 1120px
  // column, the header stops pushing and starts floating, the frame becomes a
  // constant 100vh and the document itself stops scrolling -- and because it is
  // exactly the switch src/ui.mjs adds and drops as the reviewer flips between
  // an artifact page and a question page (goToRound).
  //
  // The board opens on its NEWEST round (ADR.md entry 42) -- rounds are pages
  // now, so "which round" is a page choice, not a scroll position: the last
  // entry of `board.rounds` (src/board.mjs never reorders or skips a round
  // number). Everything below that names a round reads this one value -- the
  // badge's first-paint label, the pager's current entry and its disabled ends,
  // and whether <body> is laid out as a page board -- so a fresh load can never
  // paint one page and name another. src/ui.mjs's goToRound takes over from
  // here and keeps all three in step for every later flip.
  const initialRoundInView = board.rounds.length ? board.rounds[board.rounds.length - 1].n : 1;
  const roundsHtml = board.rounds.map(r => renderRoundSection(board, r.n, commentsByBlock)).join('\n');
  // `cwd` is dropped rather than spread: the archive (criterion 7) is a single
  // self-contained file that IS the artifact, so it is the natural thing to
  // attach to a ticket or hand to a colleague — and `board.cwd` is the realpath'd
  // local project directory (src/board.mjs), i.e. the reader's username and their
  // whole directory layout, riding along inside a document nobody reads it out
  // of. Nothing in src/ui.mjs touches it; the index page reads `cwd` off the
  // stored board, never off this payload.
  const { cwd: _cwd, ...boardForClient } = { ...board, comments: resolvedComments };
  // The page-board layout follows the PAGE on screen, not the board: a thread
  // whose first round was an artifact and whose second asks a question is one
  // board with one full-viewport page and one ordinary one, and flipping between
  // them is what adds and drops this class (src/ui.mjs's goToRound).
  const fullpage = isPageRound(board.blocks.filter(b => b.round === initialRoundInView));
  // The pill's first-paint count and label (see openRoundQuestionCount above) --
  // 'visible' only at a nonzero count, matching the docked toggle's own first-paint
  // assumption (no '.docked' class until an intersection is actually reported, i.e.
  // "the rail is off screen" is the default): the pill defaults to shown whenever
  // there is something to show, and src/ui.mjs's setupSendBarDock corrects both the
  // instant it can measure the real rail.
  const pillCount = openRoundQuestionCount(board);
  const pillLabel = `${pillCount} question${pillCount === 1 ? '' : 's'} left`;
  // The waiting signal (SPEC_AWAITED.md ticket 03, ADR.md entries 46, 47, 49):
  // `#round-meta` (the page board's own header pill slot) and `#round-countdown`
  // (the ordinary send bar's) are both first-painted from `roundIsAwaitedOpen`
  // alone -- deterministic, no clock -- and left EMPTY when the round in
  // question is open and awaited, exactly the split badge.mjs's own header
  // comment lays out (and src/pomodoro-widget.mjs's precedent for the identical
  // problem): the actual "38m left" figure is a wall-clock fact only
  // src/ui.mjs may compute, filled in at hydrate before the reader can act. The
  // deterministic (never-awaited/sent/timed-out) case needs no such deferral --
  // `read-only` is not a function of the clock at all -- so it renders directly
  // here, the same string ui.mjs's own pageBoardPillMeta falls back to.
  const initialRound = board.rounds.find(r => r.n === initialRoundInView);
  const initialRoundOpenAwaited = roundIsAwaitedOpen(initialRound);
  const roundMetaText = initialRoundOpenAwaited ? '' : 'read-only';
  const roundMetaTitle = initialRoundOpenAwaited ? '' : PILL_READONLY_TITLE;
  const latestRoundOpenAwaited = roundIsAwaitedOpen(board.rounds[board.rounds.length - 1]);
  // ADR.md entry 46: a page nobody is listening to is uncommentable whatever kind
  // its one block is (CONTEXT.md "Commentable"). The entry names three things such
  // a page must not have, and the comment-mode toggle was the one still shipping:
  // the only rule hiding it was `body.readonly`, which a LIVE non-awaited page
  // board never carries, so the header still offered "Comment mode: off", still
  // flipped to "on", and still put a crosshair cursor over an artifact where every
  // click is swallowed. Deterministic here (`roundIsAwaitedOpen`, no clock, same
  // split as the pill above); src/ui.mjs's refreshPager keeps it true afterwards,
  // including the round that expires under the reviewer.
  const pageUncommentable = fullpage && !initialRoundOpenAwaited;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<title>${escHtml(board.title || 'board')}</title>
${faviconLink}
<script>${themeBootScript}</script>
<style>${styles}</style>
</head>
<body${fullpage ? ` class="page-board${pageUncommentable ? ' page-uncommentable' : ''}"` : ''}>
<div class="board-shell">
  <div class="readonly-banner">Read-only: opened from disk, without the daemon running.</div>
  <header class="board-head">
    <div class="board-head-title">
      <a class="back-to-index" href="/" aria-label="All threads" title="All threads">${markSvg(30)}</a>
      <div class="board-head-ident">
        <h1>${escHtml(board.title || 'Untitled board')}</h1>
        <div class="meta">${escHtml(board.thread)} · ${escHtml(board.id)}</div>
      </div>
    </div>
    <div class="board-head-actions">
      ${commentModeToggle()}
      ${themeToggle()}
      <button type="button" class="round-badge" id="round-badge">${escHtml(badgeLabel(initialRoundInView, board.rounds.length))}</button>
      <span class="round-meta" id="round-meta" title="${escAttr(roundMetaTitle)}">${escHtml(roundMetaText)}</span>
    </div>
  </header>
  <div class="blocks" id="blocks">
    ${roundsHtml}
  </div>
  <button type="button" class="back-to-top" id="back-to-top" aria-label="Back to top" title="Back to top">Back to top</button>
${roundPagerMarkup(board, initialRoundInView)}
  <div class="send-bar">
    <button type="button" class="questions-left-pill${pillCount > 0 ? ' visible' : ''}" id="questions-left-pill"${hasOpenRound(board) ? '' : ' disabled'}>${escHtml(pillLabel)}</button>
    <span class="round-countdown${latestRoundOpenAwaited ? ' visible' : ''}" id="round-countdown" title=""></span>
    <span class="send-status" id="send-status">${hasOpenRound(board) ? '' : 'This round has been sent. Waiting for the next one.'}</span>
    <button type="button" class="btn-discuss" id="discuss-btn"${hasOpenRound(board) ? '' : ' disabled'}>Discuss in chat</button>
    <button type="button" class="btn-send" id="send-btn"${hasOpenRound(board) ? '' : ' disabled'}>Send</button>
  </div>
</div>
<script id="board-data" type="application/json">${safeJson(boardForClient)}</script>
<script type="module">${ui}</script>
</body>
</html>
`;
}

/** The page a browser holding no credential gets instead of a board ("the
 * refusal is a page that names the single command which restores
 * access — not a bare status code").
 *
 * A bare 401 is a correct status and a useless answer: the reader sees an empty tab and
 * has no way to tell a broken install from a cleared cookie jar. So this names the exact
 * command, with an absolute path (src/handoff.mjs `recoveryCommand`), selectable and
 * pasteable.
 *
 * It renders NOTHING about the request. No board id, no title, no store contents, not
 * even whether the board exists — the whole point of the gate is that an unauthorized
 * caller learns nothing behind it, and a "board not found" here would leak existence to
 * anything that could enumerate ids. Self-contained (inline style only, no script, no
 * network) so it renders under the same locked-down CSP every board page carries. */
export function renderRefusalPage(recoveryCommand) {
  // The seven tokens this page actually uses, emitted inline from the real palettes
  // rather than hand-copied out of them. Self-containment (see above) rules out a
  // link to src/styles.mjs's stylesheet, but it does not rule out reading the same
  // data at render time -- and that is the difference between a page that cannot
  // drift and one that merely has not yet. The first version of this page WAS
  // hand-maintained, in the sense QUIRKS.md "Two stylesheets, one palette"
  // describes, and it drifted exactly as that entry predicts: six literals that
  // matched no token in either palette, so the refusal sat in front of boards it
  // did not match. The stage keeps its literal because it renders on a surface the
  // page's tokens deliberately never reach; this page renders on the page's own
  // background, so it has no such excuse.
  const tokens = ['--bg', '--ink', '--ink-2', '--panel-2', '--hairline-2', '--code-ink', '--muted'];
  const block = (palette) => tokens.map(t => `    ${t}: ${palette[t]};`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<title>claude-board — this browser is not authorized</title>
${faviconLink}
<style>
  /* The board's saved theme is unreachable here -- it lives in localStorage,
     behind the boot script this page deliberately does not carry. The OS
     preference is therefore the only theme signal available, which is the
     right one for a standalone error page anyway: it is reached by a browser
     that, by definition, holds nothing of ours. So: two token blocks, no
     data-theme branch, and every rule below reads var() exactly like a
     board's does. */
  :root {
    color-scheme: dark;
${block(palettes.dark)}
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
${block(palettes.light).replace(/^/gm, '  ')}
    }
  }
  body { margin: 0; background: var(--bg); color: var(--ink-2); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; color: var(--ink); }
  p { margin: 0 0 1rem; }
  pre { background: var(--panel-2); border: 1px solid var(--hairline-2); border-radius: 6px; padding: .85rem 1rem; overflow-x: auto; user-select: all; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--code-ink); }
  .muted { color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>This browser is not authorized</h1>
  <p>claude-board serves boards only to a browser it has handed a credential to. This
  one is holding none — a cleared cookie jar, a different browser, or a fresh profile.</p>
  <p>Run this to authorize it. It opens a tab and nothing else changes: no reinstall, no
  restart, and your boards are untouched.</p>
  <pre><code>${escHtml(recoveryCommand)}</code></pre>
  <p class="muted">Add <code>--print</code> to get a link to paste into some other
  browser instead of opening your default one.</p>
</main>
</body>
</html>
`;
}
