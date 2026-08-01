// Board JSON -> complete HTML page, as a pure function of the JSON. The page
// inlines its own board JSON in a script tag: served through the daemon it hydrates
// and subscribes over SSE (ticket 04, see renderRoundSection and src/server.mjs);
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
// (markdown, code, mermaid, html, compare), and comments anchored at block,
// markdown heading/list-item, and element level (dom path + hint, mermaid node
// id) render here. Every comment is run through resolveComment (src/board.mjs),
// via resolveComments' shared per-block cache (ticket 11), exactly once per render
// -- see groupCommentsByBlock and renderBoardPage below
// -- and that single resolved/lost verdict feeds both the server-rendered
// per-block comment list AND whatever gets embedded for the client to hydrate
// from (the full page's `#board-data`, or an SSE push's payload -- see
// src/server.mjs), so the pin src/ui.mjs draws and the comment list beside it can
// never disagree about whether an anchor still resolves.

import { styles } from './styles.mjs';
import { ui } from './ui.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';
import { resolveComments } from './board.mjs';
import { buildSteps, stepsToPath, pathToSteps, resolveSteps } from './anchor.mjs';
import { badgeLabel } from './badge.mjs';

/** Content-Security-Policy for every board page, both as the HTTP response
 * header src/server.mjs sends on every live request AND (ticket 10,
 * DESIGN.md, audit S2) as the `<meta http-equiv>` renderBoardPage now
 * emits below. One string, not two independently-maintained policies: this is
 * the module both sides import it from, since src/server.mjs already imports
 * `renderBoardPage` itself from here (the reverse import would be circular).
 * The header is what protects a LIVE request; the meta tag is what protects an
 * archived board opened straight from disk with no daemon and no HTTP response
 * at all to carry a header on. `frame-ancestors` and `form-action` are silently
 * ignored when a policy is delivered via `<meta>` (a browser platform
 * limitation, not a mistake here) — `default-src`/`script-src`/`style-src`/
 * `img-src`/`font-src`/`connect-src`/`base-uri` are all still honoured, which is
 * the half that actually constrains a mock's own script post-ticket-10: with
 * `allow-same-origin` dropped (see renderHtmlBlock's own design comment) the
 * stage can no longer forge same-origin fetches at all, but an archived page's
 * `#board-data` (the reviewer's own answers and comments) is worth defending in
 * depth even so — see the audit's S2 for the exploit this closes (a mock's
 * script, same-origin with a `file://` parent, self-navigating to an external
 * URL with no CSP to stop it). Scoped to what the page genuinely uses: its own
 * inlined `<style>`/`<script>` (both emitted inline below, so `'unsafe-inline'`
 * is load-bearing, not laziness), mermaid's dynamic `import()` from jsdelivr
 * (src/ui.mjs), and same-origin fetch/EventSource — nothing else can load, no
 * form can post anywhere, no `<base>` can re-point a relative URL. */
export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

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

/** The one-line "you can click this" note on a stage. Both stage kinds anchor a
 * comment to an individual element (DESIGN.md board criterion 10), and neither
 * announced it: a mermaid diagram and an iframe'd mock both read as pictures, so
 * the gesture was there and undiscovered. Hidden in a standalone `file:` archive,
 * where nothing is clickable — `body.readonly` in src/styles.mjs. */
function stageHint(text) {
  return `<span class="stage-hint">${escHtml(text)}</span>`;
}

/** The comment glyph, as inline SVG rather than an emoji: an emoji renders at the
 * mercy of the platform's font (colour, weight and baseline all differ across
 * macOS/Windows/Linux, and it ignores `currentColor`, so it stayed loud while the
 * button around it went quiet). Inlined, not linked, like everything else the
 * standalone archive needs. */
const COMMENT_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/** The comment-mode toggle's icon: a crosshair, distinct from the comment glyph
 * above so the two controls don't read as the same affordance twice. See
 * DESIGN.md Decisions -> "The gesture is an explicit comment mode": this
 * button is the one thing on the page that makes the generic element-level
 * gesture discoverable without being told it exists (criterion 2) -- it has to be
 * visible chrome, not a held modifier or a hover-only affordance. src/ui.mjs reads
 * its id and toggles `.active` on it and `comment-mode` on `body`; its own click
 * never anchors anything (excluded from the click-to-anchor gesture by class, same
 * as the comment infrastructure it sits beside). */
const MODE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

/** The back-to-index control's icon: a plain left arrow, distinct from the
 * comment/mode glyphs above so three chrome controls never read as the same
 * affordance. Ticket 04 (DESIGN.md polish criterion 4): `.board-head` otherwise
 * has no way back to `/` once a reviewer is on a board page. */
const BACK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/></svg>';

/** The diagram-expand control's icon (DESIGN.md polish ticket 05): four arrowheads
 * pointing out of the corners, the standard "open this full size" glyph and
 * distinct from the three above. Inline SVG for the same reason every other icon
 * here is — the standalone archive has no network to fetch anything from. */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/></svg>';

function commentModeToggle() {
  return `<button type="button" id="comment-mode-toggle" class="mode-toggle" aria-pressed="false">${MODE_ICON}<span class="mode-toggle-label">Comment mode: off</span></button>`;
}

/** DESIGN.md polish ticket 05, criterion 10: the explicit control that opens a
 * diagram in the full-viewport lens. Explicit, and never the diagram itself —
 * "the click gesture on a diagram keeps its current meaning in both modes" (the
 * spec's own Decision), so clicking a node still means "comment on this node"
 * with comment mode on and still means nothing with it off.
 *
 * Rendered server-side rather than injected by src/ui.mjs so it is in the
 * standalone archive's own bytes, where the lens is still expected to pan and
 * zoom (spec: "The lens is view-only under `body.readonly`" — view-only, not
 * absent). That is also why src/ui.mjs's readonly pass, which hard-disables
 * every other button on the page, skips this one by class.
 *
 * src/ui.mjs's `wireDiagramExpand` removes it again if mermaid never produced an
 * SVG (CDN unreachable, invalid chart): a control that opens an empty lens is
 * worse than no control. */
function expandButton(blockId) {
  return `<button type="button" class="expand-btn" data-expand-for="${escAttr(blockId)}" aria-label="Open this diagram in the lens">${EXPAND_ICON}expand</button>`;
}

function commentButton(blockId, kind, ref, label, inline) {
  const attrs = [`data-block-id="${escAttr(blockId)}"`, `data-anchor-kind="${kind}"`];
  if (ref) attrs.push(`data-anchor-ref="${escAttr(ref)}"`);
  if (label) attrs.push(`data-anchor-label="${escAttr(label)}"`);
  const cls = inline ? 'comment-btn inline-anchor-btn' : 'comment-btn';
  // The inline variant is glyph-only, so it carries its target in an accessible
  // name instead of visible text.
  const name = label ? `Comment on ${label}` : 'Comment on this block';
  if (inline) attrs.push(`aria-label="${escAttr(name)}" title="${escAttr(name)}"`);
  const body = inline ? COMMENT_ICON : `${COMMENT_ICON}comment`;
  return `<button type="button" class="${cls}" ${attrs.join(' ')}>${body}</button>`;
}

/** Insert a small comment-trigger button right after every anchored heading/list
 * item's opening tag, using the block's own anchor list for the label. Buttons are
 * phrasing content, valid inside both headings and list items, so this never needs
 * to nest a <form>. */
function injectAnchorButtons(html, anchors, blockId) {
  const labelByRef = new Map((anchors || []).map(a => [a.ref, a.label]));
  return html.replace(/<(h[1-6]|li) id="([^"]+)"([^>]*)>/g, (whole, tag, ref) => {
    const label = labelByRef.get(ref) || ref;
    return whole + commentButton(blockId, 'md', ref, label, true);
  });
}

/** The short label shown next to a comment's number in its block's comment list:
 * the md heading/list-item label, the dom hint ("the Send button"), a diagram
 * node's own hint (ticket 05) falling back to its bare node id for an anchor
 * minted before that ticket, or "block" for a whole-block comment — and
 * "lost: <ref>" for any of
 * those once resolveComment (src/board.mjs) has decided the anchor no longer
 * resolves, so a stale anchor names what it lost instead of rendering as if
 * nothing happened. */
function anchorTag(c, lost) {
  if (lost) return `lost: ${c.lost}`;
  const kind = c.anchor && c.anchor.kind;
  if (kind === 'md') return c.anchor.label;
  if (kind === 'dom') return c.anchor.hint || c.anchor.ref;
  // Ticket 05: a diagram node's anchor now carries a hint too (composeHint, the
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
function commentArea(blockId, commentsByBlock, historical) {
  const comments = commentsByBlock.get(blockId) || [];
  const items = comments.map(c => {
    const lost = !c.resolved;
    const tag = anchorTag(c, lost);
    // The anchor a list entry points at, re-emitted as data attributes so
    // src/ui.mjs can highlight that anchor (.anchor-target, src/styles.mjs) when the
    // entry is clicked, without re-deriving the anchor from the rendered text.
    const kind = (c.anchor && c.anchor.kind) || 'block';
    const ref = (c.anchor && c.anchor.ref) || '';
    return `<div class="comment-item" data-anchor-kind="${escAttr(kind)}"${ref ? ` data-anchor-ref="${escAttr(ref)}"` : ''} data-block-id="${escAttr(blockId)}"><span class="comment-anchor${lost ? ' comment-lost' : ''}">#${c.n} · ${escHtml(tag)}</span>${escHtml(c.text)}</div>`;
  }).join('');
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

function renderMarkdownBlock(block, board, commentsByBlock, historical) {
  if (block.error) {
    return `
<section class="block markdown-block" data-block-id="${escAttr(block.id)}" data-block-kind="markdown">
  <div class="block-kicker">Markdown ${commentButton(block.id, 'block')}</div>
  <p class="resolve-error">Could not resolve: ${escHtml(block.error)}</p>
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
  }
  const withButtons = injectAnchorButtons(block.html, block.anchors, block.id);
  return `
<section class="block markdown-block" data-block-id="${escAttr(block.id)}" data-block-kind="markdown">
  <div class="block-kicker">Markdown ${commentButton(block.id, 'block')}</div>
  <div class="md-content">${withButtons}</div>
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
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
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(preview.trim())) {
    return `<img class="opt-preview opt-preview-img" src="${escAttr(preview)}" alt="">`;
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
 * itself lives in src/ui.mjs and is not asserted by the node checks (see
 * DESIGN.md Testing — that check "is not automated and should not pretend to
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

/** choose-between-rendered-variants (SPEC_MIGRATION.md criterion 2): each option carries a nested,
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
 * one widget inventing a suppressed, comment-free rendering path of its own. */
function renderVariantOption(opt, isSelected, board, commentsByBlock, historical, questionId) {
  const body = opt.block
    ? renderBlock(opt.block, board, commentsByBlock, historical)
    : '<p class="unsupported-widget">no content</p>';
  return `<div class="variant-card choice-variant${isSelected ? ' selected' : ''}" role="button" tabindex="${historical ? '-1' : '0'}"${historical ? ' aria-disabled="true"' : ''} data-question-id="${escAttr(questionId)}" data-choice="${escAttr(opt.label)}">
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
    // minted (audit L2), so every block renderWidget ever sees already named
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

function renderQuestionBlock(block, board, commentsByBlock, historical) {
  const answer = board.answers[block.id];
  const statusText = `status: ${answer ? answer.status : 'unanswered'}`;
  const isDeferred = !!(answer && answer.status === 'deferred');
  const widgetHtml = renderWidget(block, answer, historical, board, commentsByBlock);
  const contextHtml = (block.context || []).map(c => renderBlock(c, board, commentsByBlock, historical)).join('');
  return `
<section class="block question-block" data-block-id="${escAttr(block.id)}" data-block-kind="question" data-widget="${escAttr(block.widget)}">
  <div class="question-main">
    <div class="block-kicker">Question · ${escHtml(block.widget)} ${commentButton(block.id, 'block')}</div>
    <p class="question-prompt">${escHtml(block.prompt)}</p>
    ${widgetHtml}
    <div class="note-field">
      <label for="note-${escAttr(block.id)}">Note</label>
      <textarea id="note-${escAttr(block.id)}" data-note-for="${escAttr(block.id)}" placeholder="Optional note"${historical ? ' disabled' : ''}>${escHtml(answer ? answer.note : '')}</textarea>
    </div>
    <div class="question-footer">
      <button type="button" class="btn-defer${isDeferred ? ' active' : ''}" data-defer-for="${escAttr(block.id)}"${historical ? ' disabled' : ''}>Defer</button>
      <span class="answer-status" data-status="${escAttr(answer ? answer.status : 'unanswered')}">${escHtml(statusText)}</span>
    </div>
    ${commentArea(block.id, commentsByBlock, historical)}
  </div>
  ${contextHtml ? `<div class="question-context">${contextHtml}</div>` : ''}
  ${pageDomPinLayer(block.id)}
</section>`;
}

// --- context / content block kinds ---------------------------------------------

function resolveErrorNote(block) {
  return block.error ? `<p class="resolve-error">Could not resolve: ${escHtml(block.error)}</p>` : '';
}

/** Mermaid stays client-side from its CDN exactly as /visualize does today (see
 * DESIGN.md "The daemon renders markdown; the page renders mermaid") — the
 * daemon only emits the raw diagram source in a `pre.mermaid`, and src/ui.mjs finds
 * and renders every such node in the page. The stage-scoped `pin-layer` nested in
 * `.stage-wrap` is an empty, absolutely positioned sibling that src/ui.mjs
 * populates once mermaid has rendered: it is where numbered pins for `mermaid`
 * anchors (a diagram node) land, never written to here since it depends on the
 * client-rendered SVG's node positions.
 *
 * That stage-scoped layer is NOT a direct child of this `.block` section (it is
 * nested one level deeper, inside `.stage-wrap`), so `directChildPinLayer`
 * (src/ui.mjs) never finds it and `wirePageDomPins` skips this section entirely —
 * audit finding C4. A generic page-scoped `dom` anchor can still land here: on
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
  <div class="block-kicker">Mermaid ${commentButton(block.id, 'block')} ${block.error ? '' : expandButton(block.id)} ${stageHint('turn on comment mode to click a node and comment on it')}</div>
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

/** Every line of a code reference wrapped in its own `<span>`, so criterion 1's
 * "a line of a code reference" is an actual element the generic dom anchor can
 * build a step-path to -- a bare `escHtml(text)` blob had no per-line structure
 * at all. Joined back together with literal newlines (not `<br>`) so `<pre>`'s
 * whitespace still renders one visual line per source line and copy/paste still
 * yields the original text with the spans stripped. */
function renderCodeLines(text) {
  return String(text ?? '').split('\n').map(line => `<span class="code-line">${escHtml(line)}</span>`).join('\n');
}

/** A file plus a line range or section, resolved once at post time (see
 * src/resolve.mjs). No syntax highlighting — DESIGN.md Out of Scope calls that a
 * hand-rolled cost zero-dependency packaging doesn't buy. */
function renderCodeBlock(block, board, commentsByBlock, historical) {
  const label = sourceLabel(block.source);
  const kicker = ['Code', block.lang, label].filter(Boolean).map(escHtml).join(' · ');
  const body = block.error ? resolveErrorNote(block) : `<pre><code>${renderCodeLines(block.text)}</code></pre>`;
  return `
<section class="block code-block" data-block-id="${escAttr(block.id)}" data-block-kind="code">
  <div class="block-kicker">${kicker} ${commentButton(block.id, 'block')}</div>
  ${body}
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
}

// --- ticket 10 design: genuine stage isolation via postMessage -----------------
//
// DESIGN.md's Decision "Isolation of hand-mocked HTML is kept" says a
// mock's CSS and markup must never leak into or clash with the board page. Before
// this ticket that promise was false for SCRIPT: the iframe below carried
// `sandbox="allow-same-origin allow-scripts"`, and `allow-same-origin` on a
// `srcdoc` frame keeps the embedder's origin -- so a `<script>` in agent-supplied
// `block.html` ran as first-party at the daemon's own origin, could read/write
// the parent document, and (2026-07-29 audit, S1) could fetch every board on the
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
//                                          own (single-source discipline,
//                                          DESIGN.md ticket 10): only
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
//                                          before this ticket -- see "one
//                                          gesture, toggle-gated everywhere" in
//                                          DESIGN.md. The hover
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
// NO 'select' MESSAGE, DELIBERATELY (SPEC_MIGRATION.md criterion 2,
// choose-between-rendered-variants). An earlier version of this widget had
// the stage post an unconditional, content-free 'select' on every click, so
// clicking the visible mock content of an html-kind OPTION -- not just the
// card's own chrome outside the iframe -- could pick that option; the parent
// acted on it whenever the frame sat inside a '.choice-variant' card. Reverted
// (director review, before this ticket merged): every message on this channel is
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
 * (DESIGN.md ticket 10) requires here). Placed AFTER the mock's own
 * markup in the `srcdoc` string (renderHtmlBlock, below) rather than before
 * it: every listener here is attached to `document.body` itself (delegation),
 * which needs `document.body` to already exist and works regardless of
 * whether the mock's own content was added before or after this script runs --
 * see test/dom-stand-in.mjs's `runInlineScripts` for why this placement
 * matters for a real browser, not just this stand-in. */
// Exported (ticket 10) so test/check-pure.mjs and test/check-stage-isolation.mjs
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
 * substitutes. Measured in real Chrome (2026-07-31 audit, finding H5): a
 * block under `style="--accent: transparent"` rendered the hover outline
 * `rgba(0, 0, 0, 0)` -- invisible -- and this outline is the ONLY
 * per-element targeting feedback the stage gives, so a reviewer could be led
 * to anchor a comment to an element they never saw highlighted. A literal is
 * the one value untrusted content in the same document cannot override.
 * Spec criterion 6's binding amendment names this file's stage stylesheet as
 * exempt from the "no raw literal outside a token block" rule for exactly
 * this reason -- see test/check-pure.mjs, which asserts the isolation
 * property this comment describes (no custom property at all) rather than
 * merely "some hex is present".
 *
 * Pinned to --accent's LIGHT value, which is not a typo and not the palette
 * this file's document belongs to. The stage renders on `--stage-bg`, and
 * that token is '#fff' in BOTH palettes (src/styles.mjs) -- an agent-authored
 * mock assumes a white canvas, so the stage deliberately does not follow the
 * page. That makes this outline theme-INDEPENDENT: there is no light variant
 * to add, only a right and a wrong colour for white. The dark accent is the
 * wrong one. src/styles.mjs's own LIGHT palette comment already records why
 * ("#7c9cff on white is ~2.3:1"), which is the reason --accent moves to the
 * mid-blues under light; the stage was left holding the value that comment
 * rejects, on the one surface that is always white, so the outline sat at
 * 2.61:1 -- under the 3:1 WCAG minimum for non-text UI, on the ONLY
 * per-element targeting feedback the stage gives. The light accent is 6.65:1
 * against the same white. test/check-pure.mjs asserts the premise (both
 * palettes' --stage-bg identical), the requirement (contrast >= 3:1 against
 * it) and the drift guard (equality with --accent's light value), so a
 * palette change that breaks any of the three fails there rather than here. */
export const STAGE_ACCENT_HEX = '#3251c9';

export function stageAgentScript() {
  return `<script>(function () {
  var CB = 'cb-stage';
  var HOVER_CLASS = 'cb-anchor-hover';
  // DESIGN.md polish ticket 02, criterion 12: applied instead of HOVER_CLASS to
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
  // board.comments, which lives only in the parent document (ticket 10's
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
  // redundant with it, and why it tracks --accent's LIGHT value: the stage is
  // white in both palettes, so this outline is theme-independent). Injected
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
      // DESIGN.md polish ticket 02 criterion 12: a SENT_CLASS rule alongside the
      // ordinary hover one. The hover rule's colour is STAGE_ACCENT_HEX, kept in
      // step with src/styles.mjs by hand (QUIRKS.md "Two stylesheets, one
      // palette") because this stylesheet cannot reach the page's tokens -- one
      // value for both palettes, since the stage is white in both; the
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
    // Criterion 12: an element whose own ref already carries a SENT comment is
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

  window.addEventListener('message', function (ev) {
    // See this file's design comment above ("ORIGIN VALIDATION") for why
    // identity, not an origin string, is the correct and sufficient check on
    // this side of the channel.
    if (ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || typeof data !== 'object' || data.cb !== CB || typeof data.type !== 'string') return;
    if (data.type === 'mode') {
      commentMode = !!data.commentMode;
      // DESIGN.md polish ticket 02: 'sentRefs' widens this message (still 'mode',
      // not a new type -- sent-ness is exactly the kind of fact that matters
      // precisely when mode changes). Shape-checked like every other field this
      // channel carries: an absent or malformed list leaves 'sentRefs'
      // whatever it already was, rather than guessing or throwing, and a
      // non-string entry is dropped rather than compared against later.
      if (Array.isArray(data.sentRefs)) {
        sentRefs = data.sentRefs.filter(function (r) { return typeof r === 'string'; });
      }
      if (commentMode) ensureHoverStyle(); else clearHover();
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

  post({ type: 'ready' });
})();</script>`;
}

/** A raw HTML stage, for hand-mocked UI previews with no source file — the one
 * context kind passed by value (see PROTOCOL.md Blocks). Rendered inside a
 * sandboxed iframe so the mock's own markup/CSS/script never leaks into or
 * clashes with the board page — including its SCRIPT, not merely its CSS and
 * markup, since ticket 10 dropped `allow-same-origin` (see the design comment
 * above): the frame's browsing context is now genuinely cross-origin from the
 * daemon's own, so `contentDocument`/`contentWindow.document` are unreachable
 * from the parent, and element-level click-to-comment goes over the
 * `stageAgentScript` postMessage channel instead. `pin-layer` is an empty,
 * absolutely positioned sibling over the iframe that src/ui.mjs populates with
 * numbered pins for `dom` anchors, positioned from geometry the stage itself
 * reports (never written to here, since that needs a real, live DOM). */
function renderHtmlBlock(block, board, commentsByBlock, historical) {
  return `
<section class="block html-block" data-block-id="${escAttr(block.id)}" data-block-kind="html">
  <div class="block-kicker">HTML stage ${commentButton(block.id, 'block')} ${stageHint('turn on comment mode to click any element and comment on it')}</div>
  <div class="stage-wrap">
    <iframe class="html-stage" sandbox="allow-scripts" srcdoc="${escAttr(block.html + stageAgentScript())}"></iframe>
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
 * mermaid/html), rendered through the same renderBlock dispatch so it keeps its own
 * id, comment area and (for markdown) anchors -- clicking INTO a side's own
 * content anchors against that nested block's own pin-layer, found first by
 * closest('[data-block-id]') in src/ui.mjs.
 *
 * `.compare-side`/`.compare-grid` themselves are deliberately NOT chrome-excluded
 * (ANCHOR_CHROME_SELECTOR, src/ui.mjs): criterion 1 names "one side of a
 * comparison" as its own commentable unit, not just a wrapper around one, and a
 * side with no content (`renderCompareSide`'s "no content" fallback) has nothing
 * else to anchor to. So this section carries its own page-scoped
 * `pageDomPinLayer` (audit finding C4) -- without it, `directChildPinLayer`
 * (src/ui.mjs) found nothing here, `wirePageDomPins` skipped the section, and a
 * click on a compare side minted a `dom` anchor the server resolved (`resolved:
 * true`) with no pin anywhere on the page. */
function renderCompareBlock(block, board, commentsByBlock, historical) {
  return `
<section class="block compare-block" data-block-id="${escAttr(block.id)}" data-block-kind="compare">
  <div class="block-kicker">Compare ${commentButton(block.id, 'block')}</div>
  <div class="compare-grid">
    ${renderCompareSide(block.left, board, commentsByBlock, historical)}
    ${renderCompareSide(block.right, board, commentsByBlock, historical)}
  </div>
  ${pageDomPinLayer(block.id)}
  ${commentArea(block.id, commentsByBlock, historical)}
</section>`;
}

/** Dispatch by block kind. `historical` (default false) is true once the block's
 * round has been sent — see renderQuestionBlock for the answer widgets; every
 * other kind threads it into its own commentArea() too, so a sent round's comment
 * form goes inert along with its answers rather than staying a second, live place
 * to add to an exchange that already went out. Exported (ticket 04) so
 * src/server.mjs can render a single block's fragment for an SSE amend push
 * without duplicating the dispatch. */
export function renderBlock(block, board, commentsByBlock, historical = false) {
  switch (block.kind) {
    case 'markdown': return renderMarkdownBlock(block, board, commentsByBlock, historical);
    case 'question': return renderQuestionBlock(block, board, commentsByBlock, historical);
    case 'mermaid': return renderMermaidBlock(block, board, commentsByBlock, historical);
    case 'code': return renderCodeBlock(block, board, commentsByBlock, historical);
    case 'html': return renderHtmlBlock(block, board, commentsByBlock, historical);
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
 * them) but every widget renders `disabled` — see renderQuestionBlock — so it
 * collapses into a history rail rather than staying a second, stale place to edit
 * the same question. See DESIGN.md Decisions -> "A board is a session-scoped
 * thread with rounds": "the sent round collapsed into a history rail with its
 * answers still readable." Exported (ticket 04) so this is also what
 * src/server.mjs renders for an SSE push of a brand-new round — the full page and a
 * live push produce byte-identical markup for the same round, which is what makes
 * a client that reconnects mid-thread indistinguishable from one that was there the
 * whole time. */
export function renderRoundSection(board, roundN, commentsByBlock) {
  const round = board.rounds.find(r => r.n === roundN);
  const historical = !!(round && round.status === 'sent');
  const blocksForRound = board.blocks.filter(b => b.round === roundN);
  const blocksHtml = blocksForRound.map(b => renderBlock(b, board, commentsByBlock, historical)).join('\n');
  // The round's own title, when it has one (src/board.mjs stores it per round). A
  // thread routinely runs several rounds across several branches, and a rail of
  // identical "Round 1/2/3" headings tells the reviewer nothing about which is which.
  // Escaped as one string with the rest of the label, so a title carrying `<` is text.
  const title = (round && round.title) || '';
  const base = title ? `Round ${roundN} · ${title}` : `Round ${roundN}`;
  const label = historical ? `${base} · sent` : base;
  return `
<section class="round ${historical ? 'round-history' : 'round-open'}" data-round="${roundN}" data-round-status="${historical ? 'sent' : 'open'}">
  <div class="round-label">${escHtml(label)}</div>
  ${blocksHtml}
</section>`;
}

/** Render a complete, self-contained HTML page for `board`. Pure function of the
 * board JSON: same input, same output, every time. Blocks are grouped by round
 * (see renderRoundSection) rather than flattened, so a follow-up round renders
 * below the earlier ones without displacing them — see DESIGN.md "A board is
 * a session-scoped thread with rounds". Every comment is run through
 * resolveComment exactly once here (`resolvedComments`), and that single verdict
 * feeds both the server-rendered per-block comment list AND the `#board-data`
 * payload src/ui.mjs hydrates pins from — one source of truth for "does this
 * anchor still resolve", not two independently-computed ones that could disagree
 * (see DESIGN.md's board slice 06 log for what went wrong when the client
 * re-derived resolved/lost itself against the live DOM/SVG). src/server.mjs's SSE
 * push payloads build `boardForClient` the same way, for the same reason — see
 * "SSE events" in PROTOCOL.md.
 *
 * The send bar carries BOTH ways out of a round (DESIGN.md Decisions → "Two
 * ways out, plus a wall clock"): `#send-btn` posts `action:'send'`, `#discuss-btn`
 * posts `action:'discuss'` with whatever is filled in right now — partial answers
 * are the point — and tells the agent to stop posting boards. Both live inside the
 * one `.send-bar`, which `body.readonly` hides wholesale (src/styles.mjs), so the
 * standalone file:// archive has neither. */
/** Is there a round waiting to be answered? Decides whether the send bar is live at
 * HYDRATE time, which nothing used to (audit 2026-07-31 D2): the buttons were rendered
 * enabled unconditionally and only ever disabled by an SSE push handler, so a finished
 * board opened from the index had a live Send. Pressing it posted `round: null`, which
 * the server answers 400 — not the 409 the client special-cases — so the page showed
 * `Error: submit failed: 400` and re-enabled the buttons, forever. */
function hasOpenRound(board) {
  const latest = board.rounds[board.rounds.length - 1];
  return Boolean(latest && latest.status === 'open');
}

export function renderBoardPage(board) {
  const resolvedComments = resolveComments(board, board.comments);
  const commentsByBlock = groupCommentsByBlock(resolvedComments);
  const roundsHtml = board.rounds.map(r => renderRoundSection(board, r.n, commentsByBlock)).join('\n');
  const boardForClient = { ...board, comments: resolvedComments };
  // The page always loads scrolled to the top, so the topmost round -- the
  // first entry of `board.rounds`, always `1` (src/board.mjs never reorders or
  // skips a round number) -- is the correct first-paint value for N before any
  // client script has run. src/ui.mjs's IntersectionObserver (criterion 7)
  // takes over the moment it can measure real layout, and corrects this if the
  // page was opened scrolled elsewhere (e.g. a deep-linked anchor).
  const initialRoundInView = board.rounds[0] ? board.rounds[0].n : 1;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<title>${escHtml(board.title || 'board')}</title>
<script>${themeBootScript}</script>
<style>${styles}</style>
</head>
<body>
<div class="board-shell">
  <div class="readonly-banner">Read-only: opened from disk, without the daemon running.</div>
  <header class="board-head">
    <div class="board-head-title">
      <a class="back-to-index" href="/" aria-label="All threads" title="All threads">${BACK_ICON}</a>
      <div>
        <h1>${escHtml(board.title || 'Untitled board')}</h1>
        <div class="meta">${escHtml(board.thread)} · ${escHtml(board.id)}</div>
      </div>
    </div>
    <div class="board-head-actions">
      ${commentModeToggle()}
      ${themeToggle()}
      <button type="button" class="round-badge" id="round-badge">${escHtml(badgeLabel(initialRoundInView, board.rounds.length))}</button>
    </div>
  </header>
  <div class="blocks" id="blocks">
    ${roundsHtml}
  </div>
  <div class="send-bar">
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

/** The page a browser holding no credential gets instead of a board (SPEC_LAUNCH.md
 * criterion 1: "the refusal is a page that names the single command which restores
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<title>claude-board — this browser is not authorized</title>
<style>
  /* Self-contained by design (see this function's own comment), so this page
     cannot reach src/styles.mjs's tokens and cannot read the board's saved
     theme either -- it has no script, and the preference lives behind one.
     The OS preference is the only theme signal available here, which is the
     right one for a standalone error page: it is reached by a browser that,
     by definition, holds nothing of ours. Hand-maintained against the two
     palettes, in the same sense as the stage stylesheet (QUIRKS.md "Two
     stylesheets, one palette") and for the same reason. */
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f1115; color: #d7dce5; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; color: #f2f5fa; }
  p { margin: 0 0 1rem; }
  pre { background: #171a21; border: 1px solid #262b36; border-radius: 6px; padding: .85rem 1rem; overflow-x: auto; user-select: all; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9fd0ff; }
  .muted { color: #8b93a3; font-size: .9rem; }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; }
    body { background: #eef1f7; color: #171c2a; }
    h1 { color: #0d1220; }
    pre { background: #f5f6fb; border-color: rgba(0, 0, 0, 0.18); }
    code { color: #3a4c78; }
    .muted { color: #515c76; }
  }
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
