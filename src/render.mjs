// Board JSON -> complete HTML page, as a pure function of the JSON. The page
// inlines its own board JSON in a script tag: served through the daemon it hydrates
// and subscribes over SSE (see renderRoundSection and src/server.mjs);
// opened from Finder it hydrates from the embedded copy and renders read-only
// (src/ui.mjs decides based on `location.protocol`).
//
// The board JSON is the only payload still inlined. The client script and the stylesheet
// are REFERENCED, by the bare content-addressed sibling filenames src/assets.mjs names
// (ADR 70) -- roughly 430KB a page that used to be written out again for every board. The
// reference stays a pure function of the JSON, because the names are hashes of payloads
// fixed at import: the served page, the pages/ file and a fresh render are still the same
// bytes. It also keeps the page openable from Finder, as long as its folder travels with
// it -- see src/assets.mjs for why the reference has exactly that one form, and why the
// script tag is a deferred CLASSIC script rather than a module.
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

import { palettes, faviconLink, markSvg } from './styles.mjs';
import { SCRIPT_ASSET, STYLE_ASSET } from './assets.mjs';
import { themeBootScript, themeToggle } from './theme.mjs';
import { resolveComments, stripDaemonOnly } from './board.mjs';
import { buildSteps, stepsToPath, pathToSteps, resolveSteps } from './anchor.mjs';
import { grammarFor, Prism } from './vendor/prism/index.mjs';
import { MERMAID_ASSET } from './vendor/mermaid/index.mjs';
import {
  roundPageLabel, isPageRound, roundHasCommentable,
  roundIsAwaitedOpen, PILL_READONLY_TITLE, ROUND_OPEN_UNAWAITED_TITLE, PILL_SUBMITTED_TITLE,
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
 * `img-src`/`connect-src`/`base-uri` are all still honoured, which is
 * the half that actually constrains a mock's own script: with
 * `allow-same-origin` dropped (see renderHtmlBlock's own design comment) the
 * stage can no longer forge same-origin fetches at all, but an archived page's
 * `#board-data` (the reviewer's own answers and comments) is worth defending in
 * depth even so — this closes an exploit (a mock's
 * script, same-origin with a `file://` parent, self-navigating to an external
 * URL with no CSP to stop it). Scoped to what the page genuinely uses: its own
 * inline `<script>` (the theme boot script, so `'unsafe-inline'` is load-bearing,
 * not laziness), the content-addressed siblings a page names (`'self'`, ADR 70),
 * and same-origin fetch/EventSource — nothing else can load, no external host is
 * named anywhere in this policy, no form can post anywhere, no `<base>` can
 * re-point a relative URL.
 *
 * `'self'` is what admits every sibling — script, stylesheet, and mermaid's vendored
 * engine alike — and it does so on BOTH surfaces: served, the origin is the daemon's;
 * opened from Finder, Chrome's origin for a `file:` document is `file://` and a sibling
 * `file:` URL matches it. Verified against real Chrome rather than assumed — a `file:`
 * page under this exact meta policy loads every sibling. Deliberately NOT widened to a
 * bare `file:` scheme source, which would also work but would hand an archived board's
 * untrusted `html` stage (it inherits this policy through its `srcdoc`) the ability to
 * pull any script off the reader's disk.
 *
 * mermaid used to need its own allowance here — `script-src`/`font-src` both named
 * `cdn.jsdelivr.net/npm/mermaid@<version>/`, a version-pinned prefix (the only pin a
 * dynamic `import()` can carry, since it cannot ship an SRI hash) that still let a
 * compromised jsdelivr serve any file under that one version. Vendored now (a
 * digest-pinned file under src/vendor/mermaid/, loaded the same content-addressed,
 * same-origin way as the other two siblings — see src/ui.mjs), that CDN allowance is
 * gone outright rather than re-pinned: no clause in this policy names an external host
 * at all. `font-src` keeps exactly `data:` — narrowed, not dropped: the CDN fetch it
 * used to admit is gone, but an `html` stage renders at an opaque origin and inherits
 * this policy through its `srcdoc` (see above), and the manual
 * (skills/claude-board/SKILL.md) tells artifact authors to inline every font as a
 * `data:` URI for exactly that reason. Without this clause `default-src 'none'` leaves
 * a `data:` font with no source at all. */
const CSP_CLAUSES = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src data:",
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
 * standalone archive needs.
 *
 * Shared by the whole-block comment button below AND the comment-mode toggle
 * (commentModeToggle). The toggle used to carry its own
 * icon (a crosshair) precisely so the two didn't read as the same affordance;
 * that reasoning no longer holds now that the toggle names no round and holds
 * only what it does, "comment" -- one glyph for one idea, not two glyphs for two
 * spellings of it.
 *
 * Exported so test/check-pure.mjs can pin AC 9 against the real path data
 * (same discipline as src/pomodoro-widget.mjs's TOMATO_ICON/REST_ICON) rather
 * than a hand-typed copy of the `d` attribute that could silently drift from
 * what actually renders. */
export const COMMENT_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/** The diagram-expand control's icon: four arrowheads
 * pointing out of the corners, the standard "open this full size" glyph and
 * distinct from the comment glyph above. Inline SVG for the same reason every
 * other icon here is — the standalone archive has no network to fetch anything
 * from. */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/></svg>';

/** The comment-mode toggle. See "The gesture is an explicit comment mode": this
 * button is the one thing on the page that makes the generic element-level
 * gesture discoverable without being told it exists -- it has to be visible
 * chrome, not a held modifier or a hover-only affordance. src/ui.mjs reads its
 * id and toggles `.active` on it, `aria-pressed`, and `comment-mode` on `body`;
 * its own click never anchors anything (excluded from the click-to-anchor
 * gesture by class, same as the comment infrastructure it sits beside).
 *
 * The label is the static word `Comment`, never
 * `Comment mode: on`/`off` -- on/off is carried by `.active` and `aria-pressed`
 * alone, so src/ui.mjs's setCommentMode never has to rewrite it. */
function commentModeToggle() {
  return `<button type="button" id="comment-mode-toggle" class="mode-toggle" aria-pressed="false">${COMMENT_ICON}<span class="mode-toggle-label">Comment</span></button>`;
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

/** The `<div class="comment-item">` list, shared by `commentArea` below and the
 * page board's own Tray (`renderPageCommentPanel`): one rendering of a block's
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
 * `.stage-wrap` -- see DESIGN.md, "### Entry 28 — element anchoring", for the two
 * roots). A
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
 * compare side. Same shape entry 28 already gave `question`/`compare`; an archived
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

// Each widget renders the options/answer surface only; the note field, defer
// button and status line are shared chrome in renderQuestionBlock below. Every
// widget sets data-question-id / data-choice (or data-answer-for) so src/ui.mjs can
// read the current value generically without per-widget branching at Send time.

/** `opt.preview` is a plain string: rendered as an <img> when it looks like an image
 * URL, otherwise as a small preformatted snippet. No markdown/code rendering here —
 * a preview is a glance, not a second content block. */
function renderOptionPreview(preview) {
  const trimmed = String(preview ?? '').trim();
  // Parsed, not pattern-matched, and not by accident: an extension sniff written
  // as a regex (`^https?://\S+\.(png|...)(\?\S*)?$`) backtracks quadratically on a
  // crafted `.png?`-repeated string -- ~46s at 400KB, re-paid on every read, since
  // the board is persisted after the render. URL parsing is linear and answers the
  // same question.
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
 * see ADR.md entry 78 for why the stage must never be able to influence its own
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
      // blocks the ask on /wait, so the call sat for the full 40-minute cap on something
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
  // Mirrors what the two kinds do at top level. `mermaid` renders inline in THIS
  // document, so its page layer is where a `dom` anchor on the block's own chrome
  // belongs and renderMermaidBlock emits one unconditionally. A healthy `html`
  // stage's anchors all live inside the frame and are drawn in the layer stageWrap
  // already emits, so renderHtmlBlock emits a page layer only on the error path --
  // emitting one unconditionally here would give a context-nested stage TWO
  // layers, and wirePageDomPins would find the second and draw every stage-scoped
  // comment a second time, at a fabricated position, from refs that cannot resolve
  // outside the frame.
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
 * the full-width layout too, with no new grid CSS of its own.
 *
 * The note field and the footer are children of the `section`, not of
 * `.question-main`: both are about the question as a whole rather than about
 * either column, so they sit on their own grid rows below both (the stylesheet
 * spans them `1 / -1`). Keeping the note inside `.question-main` cost it half
 * the card's width for no reason -- a two-column question got a note box as
 * narrow as its options while the context card sat beside empty space. */
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
  </div>
  ${cardContextHtml ? `<div class="question-context">${cardContextHtml}</div>` : ''}
  <div class="note-field">
    <label for="note-${escAttr(block.id)}">Note</label>
    <textarea id="note-${escAttr(block.id)}" data-note-for="${escAttr(block.id)}" placeholder="Optional note"${historical ? ' disabled' : ''}>${escHtml(answer ? answer.note : '')}</textarea>
  </div>
  <div class="question-footer">
    <button type="button" class="btn-defer${isDeferred ? ' active' : ''}" data-defer-for="${escAttr(block.id)}"${historical ? ' disabled' : ''}>Defer</button>
    <span class="answer-status" data-status="${escAttr(answer ? answer.status : 'unanswered')}">${escHtml(statusText)}</span>
  </div>
</section>`;
}

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
  // Integers only, same trust boundary as gutterStart's (see its comment): `source`
  // is the caller's bytes verbatim, and a ref carrying BOTH a section and a `lines`
  // never had the range validated by src/resolve.mjs -- nor applied. Escaping alone
  // kept this inert but left the kicker claiming a line range that was never sliced.
  if (source.lines && Number.isInteger(source.lines[0]) && Number.isInteger(source.lines[1])) {
    label += `:${source.lines[0]}-${source.lines[1]}`;
  }
  return label;
}

// Syntax highlighting (ADR.md entry 62-63) runs
// server-side at POST time (renderCodeBlock is called from board.mjs's render
// path exactly like every other block), so the served page carries only the emitted
// `tok-*` spans, never the Prism engine itself, and highlighting emits classes and
// NEVER an inline colour -- that is the whole trick that lets the theme toggle
// re-colour an already-rendered block, archived boards included, for free (AC 6):
// the class names are fixed, and it is the stylesheet's `.tok-keyword { color:
// var(--code-keyword) }` that changes meaning when `data-theme` flips, not anything
// this module writes per block.
//
// Prism's own token vocabulary is much larger than the six-hue palette ADR 63
// commits to (keyword, string, function, number, comment, base) -- `boolean`,
// `builtin`, `regex`, `class-name`, `tag`, `property`, `operator`, `punctuation`
// and a few dozen more all come out of the vendored grammars. TOKEN_CLASS below is
// the one place that collapses Prism's types onto our five *coloured* classes
// (anything absent from this table falls through with no class at all, and
// inherits `.code-block pre code`'s own `--code-base` -- the sixth hue, the
// default/plain colour, needs no class of its own for exactly that reason).
// Naming the classes here, as plain string literals, is also what satisfies
// test/check-pure.mjs's orphan-class scan honestly (QUIRKS.md "the stylesheet and
// the markup are checked against each other"): that scan only reads six files for
// "a class the stylesheet rules on is a class something emits", and none of them is
// a vendored grammar file, so a class minted only inside src/vendor/prism/ could
// never satisfy it truthfully.
const TOKEN_CLASS = {
  keyword: 'tok-keyword', builtin: 'tok-keyword', boolean: 'tok-keyword', important: 'tok-keyword',
  string: 'tok-string', char: 'tok-string', 'template-string': 'tok-string', 'attr-value': 'tok-string', regex: 'tok-string',
  function: 'tok-function', 'function-variable': 'tok-function', method: 'tok-function',
  number: 'tok-number',
  comment: 'tok-comment', prolog: 'tok-comment', doctype: 'tok-comment', cdata: 'tok-comment',
  // ADR.md entry 64: the vendored 'diff' grammar's own
  // token vocabulary (coord/deleted-sign/inserted-sign/unchanged/line/prefix, see
  // src/vendor/prism/components/prism-diff.cjs) shares NONE of the names above --
  // that is what makes "a diff row never carries a six-hue tok-* class" true by
  // construction rather than by convention: nothing here maps a diff token onto
  // tok-keyword/tok-string/tok-function/tok-number/tok-comment, so flattenTokens
  // below can never produce one for diff text. 'coord' (a '---'/'+++' file header or
  // an '@@ ... @@' hunk header) is the one diff token type given a class at all --
  // 'diff-meta', never a 'tok-' name, styled `color: var(--muted); font-style:
  // italic` (src/styles.mjs) -- ADR 64's "comments go --muted italic" read onto a
  // diff's own structural lines, which are the closest thing a diff has to a
  // comment: present, but not a line either file actually contains.
  coord: 'diff-meta',
};

/** A Prism token's own `type` is only half of how a grammar names its colour: the
 * other half is `alias`, which upstream's own CSS themes treat exactly like a type
 * (Prism emits `class="token <type> <alias...>"` and every theme rule matches on
 * either). Both have to be consulted, or a grammar that names its colours entirely
 * through aliases highlights nothing at all.
 *
 * `markdown` is that grammar, and was the measured symptom: NOT ONE of its own
 * top-level type names (`title`, `bold`, `italic`, `list`, `url`, `code-snippet`,
 * `blockquote`) appears in TOKEN_CLASS, while `title` carries `alias: 'important'`
 * and `code-snippet` carries `alias: ['code', 'keyword']` -- both of which do. So a
 * `lang: 'markdown'` block emitted zero `tok-*` spans and was indistinguishable from
 * the no-grammar fallback, against AC 1's promise for any lang with a vendored
 * grammar (AC 2 required markdown to have one).
 *
 * `alias` is a string OR an array of strings, both forms present in the vendored
 * source -- hence the normalising loop rather than a single lookup. `type` still
 * wins when it is itself in the table: an alias is the grammar's secondary name for
 * a token, and the primary one is the more specific answer where both exist.
 *
 * This deliberately cannot resurrect a six-hue class on a diff row (ADR 64): the
 * diff grammar's aliases are `deleted`/`inserted`/`unchanged`/`diff`/`bold`, none of
 * which is in TOKEN_CLASS either, so "a diff row never carries a tok-* class" stays
 * true by construction across this widening. */
function tokenClass(t) {
  const own = TOKEN_CLASS[t.type];
  if (own) return own;
  const aliases = Array.isArray(t.alias) ? t.alias : (t.alias ? [t.alias] : []);
  for (const a of aliases) {
    if (TOKEN_CLASS[a]) return TOKEN_CLASS[a];
  }
  return undefined;
}

/** Walk a Prism.tokenize() result -- a flat array of plain strings and `Token`
 * objects whose own `.content` is either a string or a further array of the same
 * shape (nested grammars: a `${...}` interpolation inside a template string, a
 * regex's own sub-highlighting, ...) -- into a flat sequence of `[text, class]`
 * leaf pairs, in source order. `cls` threads the nearest COLOURED ancestor down
 * to any uncoloured descendant (an inner token type absent from TOKEN_CLASS keeps
 * reading as whatever coloured token it sits inside, rather than snapping back to
 * plain base the moment nesting starts) and is overridden the instant a nested
 * token's own type (or alias -- see tokenClass above) IS in the table.
 *
 * Concatenating every leaf's text back together, in order, reproduces the input
 * text byte for byte -- Prism's own contract for what tokenize() returns -- which
 * is what lets highlightRows below rebuild exact per-line text out of a token tree
 * that has no idea where the line breaks are. */
function flattenTokens(tokens, cls, out) {
  for (const t of tokens) {
    if (typeof t === 'string') {
      if (t) out.push([t, cls]);
      continue;
    }
    const c = tokenClass(t) || cls;
    if (Array.isArray(t.content)) flattenTokens(t.content, c, out);
    else if (typeof t.content === 'string') { if (t.content) out.push([t.content, c]); }
    else flattenTokens([t.content], c, out);
  }
}

/** The size above which a code block is rendered plain instead of tokenized.
 *
 * An earlier decision set no size cutoff on highlighting at all, backed by a
 * measurement that Prism tokenizes 512 KB -- the maximum a reference can be
 * (MAX_REF_BYTES) -- in 15 ms. That measurement is real and reproduces here (512KB
 * of this repo's own source: 20 ms). It is also measured on BENIGN input, and the
 * decision does not survive an adversarial one. Prism's grammars are ordinary
 * backtracking regexes, and several are quadratic on content that merely fails to
 * terminate:
 *
 *     typescript/tsx/jsx/javascript, `'/' + 'a'.repeat(n)`   -- an unterminated
 *       regex literal, i.e. any truncated or minified .js:
 *       4KB 73ms · 8KB 286ms · 16KB 1178ms · 32KB 3.2s · 64KB 12.7s
 *     css, `'@media ('.repeat(n)`:      16KB 144ms · 64KB 2.2s · 128KB 9.0s
 *     markup/html, `'<a b="'.repeat(n)`: 16KB 96ms · 64KB 1.5s · 128KB 6.1s
 *
 * A clean 4x per doubling in every case. MAX_REF_BYTES is 512 KiB, so the
 * unbounded worst case was minutes: a single 256 KiB block measured 256.9 SECONDS
 * through renderBoardPage. And the cost is not paid once at post time -- nothing
 * caches the highlighted markup, so it is re-paid on every renderBoardPage, every
 * SSE fragment (src/server.mjs) and every anchored-comment resolve (src/board.mjs's
 * sectionRoot pass), on a single-threaded daemon where that stops health, every
 * other board and every open stream. Same hazard class as the "persistent" one
 * test/check-pure.mjs's N2 section already pins for the markdown path -- which is
 * exactly why src/markdown.mjs overrides marked's own quadratic tokenizers; the
 * Prism path simply had neither a bound nor an N2 check.
 *
 * 8192 chosen from the table above, not from taste: it is the largest power of two
 * whose WORST measured adversarial cost (286 ms, typescript) stays in the same
 * order as a slow request rather than a hang, where the next step up is 1.2 s and
 * the one after 3.2 s -- each of them repeated on every render of that board. What
 * the cutoff costs is bounded and visible: a block over ~8 KB renders through the
 * plain-escaped branch highlightRows already has for an unvendored lang (AC 1),
 * keeping its gutter, its diff fill and its exact bytes -- it just loses colour.
 * Compared against length, not byte length, because the regex engine's work scales
 * with UTF-16 code units.
 *
 * Ceiling worth naming: this bounds the request thread by giving up a feature, not
 * by making the tokenizer linear. The upgrade path, if large blocks ever need
 * colour, is to move tokenization off the request thread (a worker, or a cache
 * keyed on the block's existing `sha`) -- at which point the cutoff can rise or go. */
const MAX_HIGHLIGHT_CHARS = 8192;

/** Split one code block's text into one HTML string per physical line -- no
 * `grammar` (AC 1's fallback: `lang` absent, or present but not vendored --
 * grammarFor never throws, just returns undefined) renders every line plain and
 * escaped, exactly as today; a real grammar wraps each recognised run in a
 * `tok-*` span per TOKEN_CLASS above.
 *
 * The row split happens on the ALREADY-ESCAPED HTML, not on the raw token
 * stream, specifically so a token that spans a line break (a block comment, a
 * multi-line template string) gets closed at the end of one row's span and
 * reopened at the start of the next, rather than emitting one span whose
 * innerHTML contains a literal newline -- renderCodeBlock below wraps each
 * returned row in its OWN `<span class="code-row">`, and a highlighting span
 * that straddled that boundary would leave broken, unbalanced markup (a `</span>`
 * belonging to one row's wrapper closing a `<span class="tok-comment">` opened in
 * the row before it). Splitting per leaf run before any wrapping happens keeps
 * every span self-contained within the one row it is ever wrapped inside. */
/** Does this text and grammar actually reach Prism, or take the plain fallback?
 * Over MAX_HIGHLIGHT_CHARS (see its comment for the measurements) a block takes
 * the same branch a missing grammar takes: same code path, same output shape, so
 * the gutter, the diff fill and copy fidelity are unaffected either way. Named
 * rather than inlined because highlightFenceHtml below has to answer the same
 * question to decide whether a fence costs anything, and two spellings of "is
 * this tokenized" is how the answer drifts. */
const willTokenize = (text, grammar) => Boolean(grammar && text && text.length <= MAX_HIGHLIGHT_CHARS);

function highlightRows(text, grammar) {
  const leaves = [];
  if (willTokenize(text, grammar)) flattenTokens(Prism.tokenize(text, grammar), undefined, leaves);
  else leaves.push([text, undefined]);

  const rows = [];
  let buf = '';
  for (const [leafText, cls] of leaves) {
    const parts = leafText.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) buf += cls ? `<span class="${cls}">${escHtml(parts[i])}</span>` : escHtml(parts[i]);
      if (i < parts.length - 1) { rows.push(buf); buf = ''; }
    }
  }
  rows.push(buf);
  return rows;
}

/** A file plus a line range or section, resolved once at post time (see
 * src/resolve.mjs), highlighted (AC 1) and numbered (AC 7) with the file's own
 * real line numbers.
 *
 * No commentButton/commentArea/pageDomPinLayer, same as renderMarkdownBlock above
 * (ADR.md entry 28) -- highlighting and the gutter are the only things this ticket
 * changes; the block still carries no comment affordance of its own.
 *
 * The gutter (AC 7, AC 8) is a `data-line` attribute per row plus a stylesheet
 * `::before { content: attr(data-line) }` (src/styles.mjs's `.code-row`), never a
 * `<span>` of literal digit characters: generated content is not selectable and
 * never lands in a copy, which a sibling text node would. Each row is its own
 * `<span class="code-row">` -- real newline characters sit BETWEEN them, exactly
 * where they sat in the original text, never inside one -- so selecting and
 * copying the whole block yields the original bytes back (AC 8): no line-number
 * digits (they were never text nodes), no injected newlines (none were added,
 * only the ones already in `block.text`), and no diff signs (this block never
 * emits any -- ticket 05's diff half owns that).
 *
 * Line numbering (the non-diff half of AC 7; ticket 05 owns numbering a diff
 * row's new/old line) is decided by gutterStart below, which also owns the trust
 * boundary in front of it: a block resolved from an explicit `source.lines: [from,
 * to]` range starts counting at `from` -- src/resolve.mjs's sliceLines already
 * hands back exactly `to - from + 1` lines with no extra trailing blank one added,
 * so every row here gets its own real gutter number with no ambiguity, a
 * genuinely blank last line of the range included. A block that carries a
 * `startLine` (the section case) starts there. Anything else -- a whole-file
 * reference, a by-value block, a range whose `from` is not an integer -- starts at
 * line 1 and drops one
 * trailing empty row -- the artifact of the file's own trailing newline, the same
 * single-pop convention src/resolve.mjs's fileLines already uses to decide a
 * file's line COUNT -- while still emitting that trailing newline byte itself
 * (just outside any row's span, uncounted, exactly as a text editor shows no
 * phantom blank line number after a file's final newline either). */
function renderCodeBlock(block) {
  const label = sourceLabel(block.source);
  const kicker = ['Code', block.lang, label].filter(Boolean).map(escHtml).join(' · ');
  const body = block.error ? resolveErrorNote(block) : codeBody(block);
  return `
<section class="block code-block" data-block-id="${escAttr(block.id)}" data-block-kind="code">
  <div class="block-kicker">${kicker}</div>
  ${body}
</section>`;
}

/** The seam (ADR.md entry 65) hooks markdown into: given a fenced
 * block's raw text and its `lang` string, tokenize it through the exact same
 * highlightRows/TOKEN_CLASS a `kind: 'code'` block's body uses and return the
 * fence's whole `<pre><code>...</code></pre>` markup -- NEVER wrapped in a gutter
 * span that carries a `data-line` number, unlike codeBody below. A markdown fence
 * carries no `source.lines`, so there is no "file's real line number" AC 7
 * promises a `kind: 'code'` block; inventing a fake 1-based count for it would
 * misrepresent that promise rather than extend it (see src/markdown.mjs's
 * renderCode for the fuller argument). Dropping the gutter also keeps copy
 * fidelity trivial here the same way AC 8 keeps it for a real code block: nothing
 * but the original bytes, `tok-*` span tags, and (diff only, see below) a
 * fill-only row wrapper ever lands inside `<code>`.
 *
 * Ticket 05 widened this for `lang: 'diff'` only: a fenced diff still has no
 * `source.lines` and therefore still gets no gutter, but the add/remove FILL
 * (ADR 64) needs nothing but the diff's own hunk headers -- classifyDiffLines
 * reads those out of `text` directly, no `source.lines` involved -- so a fenced
 * diff reuses the exact same diffCodeBody row-wrapping this function's `kind:
 * 'code'` sibling (codeBody, below) uses, just with `gutter: false`: no
 * `data-line` attribute, no reserved gutter column (`.diff-flat`,
 * src/styles.mjs), but the same `.diff-add`/`.diff-del` fill class on the same
 * row. Every OTHER language is untouched -- still the bare `tok-*`-classed join,
 * inside `<code>`, exactly as before this ticket.
 *
 * A small language label (spec contract edit, 2026-08-09: a reader had no way to
 * tell a bare fence was JSON short of reading its contents, and the standalone
 * `kind: 'code'` block already names its language in the kicker) is the one piece
 * of chrome this widens the fence to carry, and only when `lang` names a grammar
 * this build actually vendored -- `grammarFor(lang)` truthy, the SAME test
 * highlightRows already makes to decide whether to tokenize at all, so "gets a
 * label" and "gets colour" are the same condition by construction, not two rules
 * that could drift. No lang, or a lang with no vendored grammar (an unrecognised
 * fence tag, or one whose name doesn't match a SUPPORTED_LANGUAGES entry
 * case-for-case -- grammarFor does no normalising, same as highlightRows), gets no
 * label and no wrapper at all: the return value is exactly `<pre><code>...` as it
 * has always been for those two cases, byte for byte.
 *
 * The label is generated content, not a text node: `<pre><code>` is left
 * completely alone (the block chrome rule -- "never inside `<code>`" -- forbids
 * touching it) and instead an outer `<div class="fence-lang" data-lang="...">`
 * wraps the whole `<pre>`, with `src/styles.mjs`'s `.fence-lang::before { content:
 * attr(data-lang) }` painting the name -- same technique AC 7's gutter already
 * uses for its line numbers (QUIRKS.md), and for the same reason: `content:` text
 * is never a selectable/copyable DOM node, so wrapping a fence in this div cannot
 * change what `<code>`'s own textContent is, which is what AC 8's copy-fidelity
 * promise actually rests on. The label sits on the WRAPPER rather than directly on
 * `<pre>` itself specifically because `.md-content pre` is `overflow-x: auto`
 * (long lines scroll, per spec, Out of Scope) -- an absolutely-positioned
 * pseudo-element whose containing block IS the scrolling element scrolls out of
 * view with it; one level up, on a plain non-scrolling wrapper, it stays
 * pinned in the corner regardless of how far the code beneath it has scrolled.
 * `data-lang` carries `lang` through escAttr: it is the fence's own info string,
 * caller-supplied file content, landing in a double-quoted HTML attribute.
 *
 * src/markdown.mjs cannot import this directly -- src/board.mjs already imports
 * both `renderBlock` from here and `mdToHtmlAndAnchors` from there (see board.mjs's
 * own comment on that existing circular edge), so a markdown.mjs -> render.mjs
 * import would close a second cycle through board.mjs. board.mjs is the one place
 * already sitting above both modules, so it is the one that wires this function
 * into mdToHtmlAndAnchors as a plain argument -- dependency injection standing in
 * for an import edge neither module can carry. That makes board.mjs the only
 * caller, and TOKEN_CLASS/highlightRows/flattenTokens above the only
 * tokenize-and-wrap implementation in the tree: a `kind: 'code'` block and a fence
 * inside markdown both bottom out here. */
export function highlightFenceHtml(text, lang, budget = null) {
  // `budget` is src/markdown.mjs's per-document allowance (MAX_DOC_HIGHLIGHT_CHARS
  // there), a `{ remaining }` counter this function spends. MAX_HIGHLIGHT_CHARS
  // bounds ONE call, which bounds nothing when a document holds a hundred
  // just-under-cap fences and each one is its own call, so the caller counts across
  // the whole document and hands the counter down.
  //
  // The counter is spent HERE, not by the caller, because only this side knows
  // whether the fence costs anything: a fence with no info string, or one naming a
  // language this build never vendored, does no tokenizer work at all. Charging
  // those bought nothing and silently stripped the colour off the next fence that
  // could have used the budget -- an 8 KB ```cobol dump paying for a ```javascript
  // fence's highlighting. Declining tokenization (out of budget) takes the same
  // branch an unvendored language takes -- rows, gutter, diff fill and bytes all
  // unchanged, colour dropped -- but keeps the language LABEL, which names a fact
  // about the fence that is still true.
  const grammar = grammarFor(lang);
  const affordable = !budget || text.length <= budget.remaining;
  const tokenize = affordable && willTokenize(text, grammar);
  if (tokenize && budget) budget.remaining -= text.length;
  const rows = highlightRows(text, tokenize ? grammar : undefined);
  const body = lang === 'diff' ? diffCodeBody(rows, classifyDiffLines(text), { gutter: false }) : rows.join('\n');
  const pre = `<pre><code>${body}</code></pre>`;
  if (!lang || !grammar) return pre;
  return `<div class="fence-lang" data-lang="${escAttr(lang)}">${pre}</div>`;
}

/** AC 7's diff half: a diff row's gutter number is never `block.source.lines` arithmetic
 * (that describes a byte range of the .diff FILE ITSELF, if the reference sliced
 * one -- meaningless as a line number in either file the diff *describes*). It
 * comes from walking the diff's own `@@ -oldStart,oldCount +newStart,newCount @@`
 * hunk headers, which is what this function does, independently of highlightRows /
 * Prism's own tokenization above (Prism's diff grammar groups same-prefix lines
 * into one token spanning several physical lines and has no idea what a hunk header
 * even means -- it just recognises 'coord' as *a* line shape. Line numbering needs
 * the actual arithmetic, not a token type, so it is done here, once, on the raw
 * text, in lockstep with `text.split('\n')` -- the exact same split highlightRows
 * performs internally, so index i here and row i there always describe the same
 * physical line).
 *
 * Returns one `{ kind, line }` per physical line of `text`: 'meta' with a null
 * line for a hunk header, a file header ('---'/'+++'/'diff --git'/'index ...') or
 * anything outside a hunk; 'add' numbered in the NEW file (AC 7); 'del' numbered
 * in the OLD file, which is AC 7's "falling back to the old number" -- a removed
 * row has no new-file line at all; 'context' numbered in the new file too, the one
 * convention chosen since this renderer has a single gutter column.
 *
 * WHAT COUNTS AS A HEADER is decided by hunk state, never by the line's own first
 * bytes, and that is the whole correctness argument here. A row's '+'/'-' prefix is
 * prepended to the FILE'S OWN BYTES, so a removed line whose content starts with
 * '--' arrives as '---...' and an added line starting with '++' arrives as '+++...'
 * -- indistinguishable, by spelling, from a file header. Testing the spelling first
 * (which this did) misread both as headers and set BOTH counters to null, so every
 * following row in the hunk silently lost its gutter number AND its diff-add/
 * diff-del tint. Trivially reachable: a '---' horizontal rule or YAML front matter
 * in any .md, a '--' comment in any .sql.
 *
 * So the hunk header's own declared counts are consumed instead: '@@ -a,b +c,d @@'
 * promises exactly `b` old-file lines and `d` new-file lines (a missing count is 1,
 * git's own default), a '-' row spends one old, a '+' row spends one new, a context
 * row spends one of each, and the hunk ENDS the moment both are spent. Inside a
 * hunk every row is content, header-shaped or not; outside one every row is 'meta',
 * which covers the preamble, '---'/'+++'/'diff --git'/'index', and equally the
 * extended headers nothing here enumerates (old mode/new mode/similarity index/
 * rename from-to/Binary files differ) -- they are meta because they are outside a
 * hunk, not because they were listed. Leaving hunk state at exhaustion is also what
 * keeps a PLAIN (non-git) multi-file diff correct: it has no 'diff --git' line to
 * fall back on, so its second file's '---'/'+++' pair can only be recognised as
 * headers by the first file's hunk already being finished.
 *
 * A '\' line ('\ No newline at end of file') is meta before any of that: it is a
 * line of neither file -- git's note ABOUT the preceding line -- so it takes no
 * gutter number and spends nothing. Treated as context it would take a number of
 * its own and advance both counters, pushing every row after it in the hunk off by
 * one (canonically: the '+three!' of a last-line edit rendering as line 4 of a
 * three-line file).
 *
 * A malformed diff still degrades rather than throwing: counts that overstate the
 * body leave the hunk open to the end of the text (today's behaviour), and a text
 * with no '@@' at all never enters a hunk, so every row reads 'meta' and no line
 * number is ever invented. */
function classifyDiffLines(text) {
  const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const out = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('\\')) {
      out.push({ kind: 'meta', line: null }); // '\ No newline at end of file'
      continue;
    }
    // Checked ahead of the in-hunk branch so a truncated hunk (declared counts
    // larger than the body actually delivered) still resyncs at the next real
    // header. A hunk header can only be confused with content at column 0, and a
    // diff row's own prefix always occupies that column -- ' @@ ...', '+@@ ...' and
    // '-@@ ...' all fail this pattern -- so nothing inside a hunk can match it.
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = oldLeft > 0 || newLeft > 0; // '@@ -0,0 +1,3 @@' (a new file) has an empty old side
      out.push({ kind: 'meta', line: null });
      continue;
    }
    if (!inHunk) {
      out.push({ kind: 'meta', line: null }); // preamble, file/extended headers, between hunks
      continue;
    }
    if (line.startsWith('+')) { out.push({ kind: 'add', line: newLine }); newLine += 1; newLeft -= 1; }
    else if (line.startsWith('-')) { out.push({ kind: 'del', line: oldLine }); oldLine += 1; oldLeft -= 1; }
    else { out.push({ kind: 'context', line: newLine }); newLine += 1; oldLine += 1; newLeft -= 1; oldLeft -= 1; }
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }
  return out;
}

/** Ticket 05's diff half of AC 7/8, built ON highlightRows/codeBody rather than
 * beside them: `rows` (the highlighted, per-line HTML) and `info` (the structural
 * kind/line-number per physical line, from classifyDiffLines above) are two
 * independent passes over the SAME `text.split('\n')`, so they line up index for
 * index -- row i's markup and info[i]'s classification always describe the same
 * physical line.
 *
 * `diff-add`/`diff-del` on `.code-row` are the ONLY colour this adds -- an
 * α-0.12 `--good`/`--critical` fill (ADR 64), never a `tok-*` class, which
 * TOKEN_CLASS's own diff entries (see above) make impossible by construction, not
 * merely by not calling this function for that. A 'meta'/'context' row gets no
 * fill class at all.
 *
 * `gutter` is the one thing that differs between this function's two callers.
 * codeBody (below, a `kind: 'code'` diff block) passes the default `true`: it has
 * real `source.lines`-adjacent hunk-header numbers to give (AC 7), so every row
 * carries `.code-row`'s full reserved-gutter-column treatment, blank cell and all
 * on a header row. highlightFenceHtml (above, a markdown diff fence) passes
 * `false`: a fence has no `source.lines` and never did (ADR 65), so it gets the
 * FILL (needs only the diff's own hunk headers, nothing file-position-shaped) but
 * not the gutter -- no `data-line` attribute, and `.diff-flat` (src/styles.mjs)
 * strips the reserved gutter column's padding so a fenced diff's rows sit flush
 * left like every other fence, rather than indented for a column that would never
 * show anything. One row-wrapping function, one shared shape, a boolean is the
 * whole difference -- not a second implementation. */
function diffCodeBody(rows, info, { gutter = true } = {}) {
  return rows.map((row, i) => {
    const { kind, line } = info[i] || { kind: 'meta', line: null };
    const classes = ['code-row'];
    if (!gutter) classes.push('diff-flat');
    if (kind === 'add') classes.push('diff-add');
    else if (kind === 'del') classes.push('diff-del');
    // A header/hunk row (AC 7's "not a source line") gets no `data-line` attribute
    // at all, rather than an empty one -- `attr(data-line)` on a missing attribute
    // already renders as '' (a blank gutter cell), so this is the same visible
    // result with no attribute noise on a header row's markup. A fence (gutter:
    // false) never gets one either, regardless of `line` -- it has no gutter
    // column to fill in the first place.
    const dataLine = gutter && line != null ? ` data-line="${line}"` : '';
    return `<span class="${classes.join(' ')}"${dataLine}>${row}</span>`;
  }).join('\n');
}

/** The gutter's first line number, and the trust boundary in front of it.
 *
 * `block.source` is stored VERBATIM by src/board.mjs (`source: raw.source ?? null`),
 * so everything on it is caller-supplied bytes, not a validated shape -- and
 * src/resolve.mjs only validates `lines` in the `else if (ref.lines)` arm of an
 * if/else whose first arm is `ref.section`. A reference carrying BOTH selectors
 * therefore resolves through the section branch with `lines` never checked and no
 * `error` set at all: the block looks perfectly healthy, and `source.lines[0]`
 * arrives here as whatever the caller wrote. It used to be interpolated straight
 * into `data-line="..."` -- the one value in that template that was not escaped,
 * where every sibling goes through escAttr/escHtml -- which put live markup on the
 * page out of an attribute, once per row.
 *
 * Hence Number.isInteger, not just escaping. Escaping alone leaves an inert but
 * nonsense gutter rendered through `::before { content: attr(data-line) }`;
 * validating alone leaves the next caller that reaches this attribute exposed. A
 * value that is not an integer is not a line number, so the block is simply not an
 * explicitly-ranged one and numbers from 1 like any whole-file block.
 *
 * `block.startLine` is the section case (a block resolved by `section` has
 * `source.section` and no `source.lines`, so it used to take the "starts at line 1"
 * branch and number a section beginning at file line 6 as though it began at 1 -- a
 * reviewer citing a gutter number was five off). It is read off the BLOCK rather
 * than off `block.source` deliberately: src/board.mjs builds a code block from an
 * explicit field list, so a normalised block field cannot be forged by a caller the
 * way anything under `source` can. src/resolve.mjs reports it on every successful
 * resolution (`sliceSection` returns `startLine`, 1-based, and `resolveRef` passes it
 * on) and src/board.mjs copies it onto the block; a caller of renderBlock may also
 * supply one directly, and the same integer check guards it either way. */
function gutterStart(block) {
  const ranged = block.source && Array.isArray(block.source.lines) && Number.isInteger(block.source.lines[0]);
  if (ranged) return { start: block.source.lines[0], hasExplicitRange: true };
  if (Number.isInteger(block.startLine)) return { start: block.startLine, hasExplicitRange: false };
  return { start: 1, hasExplicitRange: false };
}

function codeBody(block) {
  const text = String(block.text ?? '');
  const rows = highlightRows(text, grammarFor(block.lang));
  const isDiff = block.lang === 'diff';
  const info = isDiff ? classifyDiffLines(text) : null;

  // `hasExplicitRange` stays tied to `source.lines` alone: it is src/resolve.mjs's
  // sliceLines specifically that hands back exactly `to - from + 1` lines with no
  // trailing blank added, which is what makes suppressing the trailing-newline pop
  // correct there. A section slice has no such guarantee, so it keeps the ordinary
  // single-pop convention along with every whole-file and by-value block.
  const { start: startLine, hasExplicitRange } = gutterStart(block);
  let trailingNewline = false;
  if (!hasExplicitRange && rows.length > 1 && rows[rows.length - 1] === '') {
    rows.pop();
    if (info) info.pop();
    trailingNewline = true;
  }

  let numbered;
  if (isDiff) {
    numbered = diffCodeBody(rows, info);
  } else {
    numbered = rows.map((row, i) => `<span class="code-row" data-line="${escAttr(startLine + i)}">${row}</span>`).join('\n');
  }

  // 'code-diff' (AC 5): overrides '.code-block pre code's own --code-base default
  // by specificity alone (src/styles.mjs) -- syntax colour "drops to --code-ink"
  // for a diff block specifically, never for an ordinary highlighted one.
  const codeClass = isDiff ? ' class="code-diff"' : '';
  return `<pre><code${codeClass}>${numbered}${trailingNewline ? '\n' : ''}</code></pre>`;
}

// --- the stage postMessage channel ------------------------------------
//
// The message tables, origin/identity rules and shape-validation rules are in
// PROTOCOL.md, "Stage postMessage channel". src/ui.mjs holds the parent half of
// this channel; STAGE_SCRIPT below is the stage half.
//
// The two rules to know before editing either side:
//
//   - The frame carries `sandbox="allow-scripts"` and NOT `allow-same-origin`,
//     so its origin is opaque and the parent cannot reach into it at all. Adding
//     `allow-same-origin` back to a `srcdoc` frame keeps the embedder's origin,
//     which would let agent-supplied `block.html` run first-party at the
//     daemon's origin, read the parent document, and answer another agent's
//     blocked `ask()`. test/check-stage-isolation.mjs proves it stays opaque.
//   - Every message is stage-authored input. Both sides validate identity
//     (`event.source`, which the browser stamps and no script can forge) and
//     then every field's type, before acting.
//
// And one decision that reads as a gap: there is deliberately NO 'select'
// message. A message that could pick an option is the agent answering its own
// question, and it cannot be guarded, only removed -- any stage's script can
// forge one directly on this channel's fixed public marker. An option's stage
// is instead `pointer-events: none` inside a '.choice-variant' card, so a real
// click lands on the card in the parent document. ADR.md entry 78 carries the two
// attack paths in full.

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

  /** Top-up, not add (ADR.md entry 59): 'top'/'bottom' are the
   * board's OWN chrome bands, never simply written -- padding-top/-bottom
   * become the LARGER of this document's own CURRENT cascade padding and
   * whatever the board just reported, so an artifact that already cleared the
   * band on its own keeps its own number untouched and one that
   * pads nothing gets exactly the band. Padding only, on
   * 'document.body' itself -- no background, colour or border is ever set
   * here.
   *
   * "Own" is read FRESH on every call, never cached from the first one --
   * clear this document's own previous inline write before measuring, so the
   * read reflects the artifact's live stylesheet cascade rather than an
   * earlier call's own number. A once-only baseline (this function's first
   * cut) gets this wrong in both directions the moment the artifact's own
   * padding is RESPONSIVE (a media query, say: 12px narrow, 64px past
   * 900px) -- a baseline captured narrow stays 12 forever even once the
   * reader widens past 900px and the artifact's own CSS asks for 64
   * (silently under-cleared), and a
   * baseline captured wide pins the artifact at 64px on a phone width where
   * its own CSS asks for 12 (over-cleared, permanently, for the rest of the
   * session). Clearing before every read is what keeps the artifact's own
   * responsive rules authoritative instead of frozen at whatever they were on
   * first contact -- and it defeats compounding the same way the once-only
   * capture did, since each call starts from the artifact's own true cascade
   * value, never from a previous 'band' call's inline write.
   *
   * getComputedStyle is feature-detected exactly like every other real-layout
   * read in this repo (QUIRKS.md "The stand-in has no layout"): unsupported or
   * unreadable leaves the reading at 0, which is the same answer a genuinely
   * unpadded artifact would give.
   *
   * ponytail: this pads 'document.body' unconditionally, which is correct for
   * a document that scrolls as a whole (the shape SKILL.md's own "a top
   * padding on its own body" convention already assumed, and the common
   * case). It is wrong for the artifact shape this file's own design comment
   * records above ("The thing that scrolls a rendered artifact is often not
   * its document" -- a fixed sidebar beside a 'height: 100vh' pane, measured
   * in Chrome 151): there, body padding pushes the 100vh pane down by exactly
   * the padding amount, its own bottom falls out of the frame, and the
   * artifact gains a body scrollbar it never had while the fixed sidebar
   * stays put -- worse than unpadded. The ceiling is not lifted here: a
   * static "does the document currently scroll" check
   * ('document.scrollingElement.scrollHeight <= clientHeight') cannot tell
   * that shape apart from an ordinary SHORT artifact that fits one screen and
   * still needs the top clearance -- both read true before any band is ever
   * applied, and wrongly skipping the far more common short-artifact case
   * would trade a rare regression for a common one (criterion 1 failing on
   * exactly the simplest artifacts). The real upgrade path is a signal this
   * function does not have yet -- an artifact that opts itself out, or a
   * shape test sturdier than a single geometry snapshot -- not a guess from
   * one number. */
  function applyBand(top, bottom) {
    if (!document.body) return;
    document.body.style.paddingTop = '';
    document.body.style.paddingBottom = '';
    var ownTop = 0;
    var ownBottom = 0;
    try {
      if (typeof getComputedStyle === 'function') {
        var cs = getComputedStyle(document.body);
        var parsedTop = parseFloat(cs.getPropertyValue('padding-top'));
        var parsedBottom = parseFloat(cs.getPropertyValue('padding-bottom'));
        if (isFinite(parsedTop)) ownTop = parsedTop;
        if (isFinite(parsedBottom)) ownBottom = parsedBottom;
      }
    } catch (e) { /* no computed style reachable -- treat the artifact as padding nothing */ }
    document.body.style.paddingTop = Math.max(ownTop, top) + 'px';
    document.body.style.paddingBottom = Math.max(ownBottom, bottom) + 'px';
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
    // The VISIBILITY half only: an element whose own ref already carries a SENT
    // comment is de-affordanced (SENT_CLASS) rather than marked as an ordinary
    // target (HOVER_CLASS), while the click handler below still posts 'click'
    // unconditionally. "Clicking it does nothing" is enforced on the other side
    // of the channel (src/ui.mjs's handleStageClick calls isSentAnchor before
    // ever opening a form), which is the side that holds board.comments and can
    // tell a resolved sent comment from a stale ref this document has no way to
    // distinguish on its own.
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
  // 'contentDocument' at all (PROTOCOL.md "Stage postMessage channel" for why the
  // frame is opaque by design, and "Origin validation" for what each side checks
  // instead),
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
  // A real scroll listener, deliberately: the no-scroll-handler rule
  // (src/badge.mjs) is a rule about the BOARD page, where an
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

  /** Move this document BY 'delta' -- one wheel notch a reviewer turned over a
   * variant card, forwarded by the parent (src/ui.mjs's wheel listener).
   * A clipped option's stage is the one surface where no real wheel can ever
   * reach this document at all: the frame is 'pointer-events: none' inside a
   * '.choice-variant' card (ADR.md entry 78, unchanged by this), so the
   * gesture lands on the card in the parent -- which cannot scroll an
   * opaque-origin document either. Hence a message, aimed at whatever last
   * scrolled, exactly like scrollTo above.
   *
   * 'auto', never the 'smooth' scrollTo uses: a notch is already the reader's
   * own granularity, and a per-notch animation has the next notch arriving on
   * top of an unfinished one -- the whole gesture stutters. Same
   * feature-detection floor as scrollTo, for the same reason (a 'scrollBy'
   * that silently does nothing never throws). */
  function scrollByStep(delta) {
    var target = scroller || window;
    if (typeof target.scrollBy === 'function') {
      try {
        target.scrollBy({ top: delta, left: 0, behavior: 'auto' });
        return;
      } catch (e) { /* older two-argument signature only; fall through */ }
      target.scrollBy(0, delta);
      return;
    }
    if (scroller) { scroller.scrollTop += delta; return; }
    if (typeof target.scrollTo === 'function') target.scrollTo(0, scrollTopNow() + delta);
  }

  // The board's theme control paints this document too, so a
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
    // See PROTOCOL.md "Origin validation", last bullet, for why identity and not
    // an origin string is the correct and sufficient check on this side of the
    // channel.
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
      // (over the channel that already carries comment mode), rather than
      // minting a type of its own: same tolerance, same
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
    if (data.type === 'scrollBy') {
      // Parent -> stage only, no outbound half: a wheel notch turned over a
      // clipped variant card, which is a gesture this document can never
      // receive on its own (scrollByStep's own comment above). Relative, not
      // absolute, deliberately -- the parent knows how far the reviewer just
      // turned, never where this document currently is; the offset is this
      // side's fact, and the browser clamps it at both ends for free.
      // Shape-checked the same way every other inbound number on this channel
      // is.
      if (typeof data.delta !== 'number' || !isFinite(data.delta)) return;
      scrollByStep(data.delta);
      return;
    }
    if (data.type === 'band') {
      // Parent -> stage only, no outbound half: the board telling this
      // document how tall its own chrome bands are right now (ADR 59).
      // Shape-checked the same way every other inbound number on
      // this channel is -- a non-finite or negative value never reaches
      // applyBand, which would otherwise hand it straight to a style
      // property.
      if (typeof data.top !== 'number' || !isFinite(data.top) || data.top < 0) return;
      if (typeof data.bottom !== 'number' || !isFinite(data.bottom) || data.bottom < 0) return;
      applyBand(data.top, data.bottom);
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
  // exactly the way src/ui.mjs's setupSendBarDock guards
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

/** Does this stage's own markup carry a mermaid diagram? A TEXTUAL test on the
 * class marker, deliberately -- the stage's bytes are all this renderer has, and
 * parsing them to ask the same question would answer no better. A diagram whose
 * node is BUILT at runtime (an artifact that mints `<pre class="mermaid">` from
 * data after load) is a known false negative and an accepted one: it gets what it
 * gets today, raw source, and the cost of catching it is providing the engine to
 * every stage on the board.
 *
 * Matches the marker as a whole word inside a `class` attribute, quoted or bare,
 * so `class="mermaid"` and `class="figure mermaid"` both count while
 * `data-x="mermaid"` and `class="notmermaid"` do not. */
const STAGE_MERMAID_MARKER = /\bclass\s*=\s*(?:["'][^"']*)?\bmermaid\b/;

export function stageCarriesMermaid(html) {
  return STAGE_MERMAID_MARKER.test(String(html ?? ''));
}

/** What a diagram-bearing stage gets prepended, and the reason it is TWO tags.
 *
 * A stage is `sandbox="allow-scripts"` with no `allow-same-origin`, so it runs at
 * an opaque origin, and the two surfaces a board has to work on answer a
 * subresource request there differently. Measured in Chrome against this exact
 * shape (the page's own CSP, inherited through `srcdoc`):
 *
 *  - SERVED: the bare sibling filename resolves against the parent's base URL
 *    (`/b/<name>`, the daemon's one static route) and the inherited
 *    `script-src 'self'` admits it from the opaque origin. The engine is a
 *    classic, non-deferred script, so it is fully live before any of the stage's
 *    own scripts run -- which is the whole point: an artifact's own loader
 *    (`if (!window.mermaid) ...`) short-circuits unmodified, and its CDN fallback
 *    never starts.
 *  - `file://`: the same tag ALWAYS errors, whatever the CSP says. Only a
 *    file:-origin context may load a `file:` subresource, and an opaque origin is
 *    not one; verified with no CSP at all and with an explicit `script-src file:`.
 *    Nothing this renderer can emit opens that, so the second tag is what serves
 *    the archive surface.
 *
 * The inline prelude therefore shape-checks `window.mermaid` (the same "an
 * impostor must not pass" idiom as src/ui.mjs's `looksLikeMermaidEngine` -- a
 * corrupt or truncated engine file that still defines the name must degrade, not
 * render nothing) and, when the real engine did not arrive, installs a small
 * facade with the same API surface that renders by asking the PARENT, over the
 * stage message channel, and swaps the returned SVG in only on success. Failure
 * anywhere leaves the raw diagram source exactly where it was -- never a blanked
 * figure, the same honesty board-level mermaid already keeps.
 *
 * Exotic mermaid API use past `initialize`/`run`/`init`/`render`/`startOnLoad`
 * degrades to raw source; accepted rather than shipping the 3.4MB engine into
 * every stored page (ADR 70's weight argument), which is what this whole shape
 * exists to avoid.
 *
 * The payload below is deliberately terse -- it is stored inside an attribute of
 * every diagram-bearing stage in every written page, so its comments would be
 * paid for per stage forever (ADR 70's weight argument again). What a reader
 * needs is here instead:
 *
 *  - `shaped()` is `looksLikeMermaidEngine`'s idiom (src/ui.mjs): a DOM element
 *    carrying `id="mermaid"` becomes `window.mermaid` for free, and so does half
 *    a truncated download, so the served surface is detected by API shape and
 *    never by truthiness.
 *  - The inbound check is `ev.source === window.parent`, not an origin
 *    comparison: a stage cannot know the parent's origin in advance (any port,
 *    or `file://`), and no script in any window can make `event.source` equal a
 *    different window's `window.parent`. This is the stage half of the rule
 *    PROTOCOL.md's "Origin validation" already states for this channel.
 *  - A node is claimed with `data-processed` BEFORE the round trip, the way the
 *    real engine claims one before its own first await, so two overlapping runs
 *    never draw the same figure. A node whose render failed has its claim
 *    RELEASED and its own text left untouched: the figure reads as raw source,
 *    never as nothing, and a later pass may still succeed. `settle` is the ONE
 *    place that decides that, which is why a `postMessage` that never left
 *    (an artifact config carrying something unclonable, no parent at all) goes
 *    through it too rather than leaving the figure claimed and waiting forever.
 *  - `startOnLoad` fires on `load` and not on `DOMContentLoaded`, which is
 *    exactly what the real engine registers. An artifact that draws its own
 *    diagrams from an end-of-body script has already run (and already turned
 *    `startOnLoad` off through `initialize`) by the time this fires, so nothing
 *    is ever drawn twice.
 *  - EVERY REQUEST IS REPEATED UNTIL IT IS ANSWERED, and that is the one part
 *    of this payload that is not an optimisation. The parent's `message`
 *    listener belongs to its DEFERRED client script (ADR 70's `ui-<hash>.js`),
 *    which by spec cannot run until the whole board page has parsed -- while
 *    this document's own scripts run as soon as its frame exists. Nothing
 *    orders those two, so a single fire-and-forget send is simply LOST whenever
 *    this side wins, and the figure sits on raw source for the rest of the
 *    page's life with nothing to say why. Measured as an intermittent archive
 *    failure across five headless recipes before this existed
 *    (test/browser-check-mermaid-stage.mjs). A resend carries the SAME
 *    `requestId`, and src/ui.mjs drops a `requestId` already in flight for that
 *    frame, so repeating costs the parent nothing and can never draw a figure
 *    twice. `RESEND_TICKS` bounds it at twelve seconds, past any plausible
 *    parse; giving up releases every claim so the figures read as their own raw
 *    source rather than staying claimed forever.
 *
 * The same race exists, unfixed, for `stageAgentScript`'s own `ready` message
 * one function up -- a stage that announces itself before the parent listens is
 * never wired for comment mode, pins or the chrome band. It predates this and
 * is not this function's to fix; a shared handshake would not close it either,
 * since a parent broadcast can land on the `about:blank` window a `srcdoc`
 * frame holds before its own navigation commits. The honest fix there is the
 * same one used here, applied to that script. */
export function stageMermaidPrelude() {
  return `<script src="${MERMAID_ASSET}"></script><script>(function () {
  var CB = 'cb-stage', pending = {}, seq = 0, config = {}, timer = null, ticks = 0;
  var RESEND_MS = 150, RESEND_TICKS = 80;
  function shaped(m) { return !!m && typeof m.run === 'function' && typeof m.initialize === 'function'; }
  if (shaped(window.mermaid)) return;
  function post(msg) {
    try { msg.cb = CB; window.parent.postMessage(msg, '*'); return true; } catch (e) { return false; }
  }
  function settle(job, svgs) {
    for (var i = 0; i < job.nodes.length; i++) {
      var svg = typeof svgs[i] === 'string' && svgs[i] ? svgs[i] : null;
      if (svg) job.nodes[i].innerHTML = svg;
      else job.nodes[i].removeAttribute('data-processed');
    }
    job.resolve(typeof svgs[0] === 'string' && svgs[0] ? svgs[0] : null);
  }
  function pump() {
    var id, live = false;
    for (id in pending) { live = true; post(pending[id].msg); }
    if (!live || ++ticks < RESEND_TICKS) { if (!live) { clearInterval(timer); timer = null; } return; }
    clearInterval(timer);
    timer = null;
    for (id in pending) { var job = pending[id]; delete pending[id]; settle(job, []); }
  }
  function ask(nodes, sources) {
    var id = 'sm' + (++seq);
    return new Promise(function (resolve) {
      var msg = { type: 'mermaid', requestId: id, sources: sources, config: config };
      var job = { nodes: nodes, resolve: resolve, msg: msg };
      pending[id] = job;
      if (!post(msg)) { delete pending[id]; settle(job, []); return; }
      if (!timer) { ticks = 0; timer = setInterval(pump, RESEND_MS); }
    });
  }
  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.cb !== CB || d.type !== 'diagrams') return;
    var job = pending[d.requestId];
    if (!job) return;
    delete pending[d.requestId];
    settle(job, Array.isArray(d.svgs) ? d.svgs : []);
  });
  function run(opts) {
    opts = opts || {};
    var raw = opts.nodes
      ? (opts.nodes.length === undefined ? [opts.nodes] : [].slice.call(opts.nodes))
      : [].slice.call(document.querySelectorAll(opts.querySelector || '.mermaid'));
    var nodes = [], sources = [];
    for (var i = 0; i < raw.length; i++) {
      var el = raw[i];
      if (!el || !el.getAttribute || el.getAttribute('data-processed') === 'true') continue;
      var src = String(el.textContent || '').trim();
      if (!src) continue;
      el.setAttribute('data-processed', 'true');
      nodes.push(el);
      sources.push(src);
    }
    if (!nodes.length) return Promise.resolve();
    return ask(nodes, sources);
  }
  function initialize(c) {
    config = c && typeof c === 'object' ? c : {};
    if (config.startOnLoad !== undefined) api.startOnLoad = !!config.startOnLoad;
  }
  var api = {
    startOnLoad: true,
    initialize: initialize,
    run: run,
    init: function (c, nodes) {
      if (c && typeof c === 'object') initialize(c);
      return run(nodes ? { nodes: typeof nodes === 'string' ? document.querySelectorAll(nodes) : nodes } : undefined);
    },
    render: function (id, text) {
      return ask([], [String(text == null ? '' : text)]).then(function (svg) {
        if (!svg) throw new Error('the board could not draw this diagram');
        return { svg: svg, bindFunctions: function () {} };
      });
    },
    contentLoaded: function () { if (api.startOnLoad) run(); },
  };
  window.mermaid = api;
  window.addEventListener('load', function () { api.contentLoaded(); });
})();</script>`;
}

/** The `srcdoc` every html stage gets, whole-block or nested in a question's
 * context (renderContextInner, below) alike: the margin reset, the engine
 * prelude if this stage has a diagram at all, the mock's own markup, then the
 * stage-side agent script -- one construction, so the two call sites can never
 * drift apart on what a stage actually is.
 *
 * The prelude is strictly conditional and sits BEFORE the mock's own markup:
 * a stage with no diagram in it names no engine and its page's bytes are exactly
 * what they were before any of this existed, and a stage with one has the engine
 * live before its own first script. Both tags are head-only elements, so they
 * hoist out of `body` with the margin reset already there (see renderHtmlBlock's
 * own comment on that hoist) and no `dom` anchor's index chain shifts. */
export function buildStageSrcdoc(block) {
  const prelude = stageCarriesMermaid(block.html) ? stageMermaidPrelude() : '';
  return STAGE_MARGIN_RESET + prelude + block.html + stageAgentScript();
}

/** The awaited page's own send control (ADR.md
 * entries 45, 46, 40). `.page-comments` (renderHtmlBlock's fullpage branch,
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
 *   - open and awaited, short of its deadline: the live surface -- the Tray's
 *     chat-style order (CONTEXT.md): the list first, then the compose form
 *     (with the hint line while the list is empty, teaching the
 *     click-to-comment gesture, since comment mode already starts ON here and
 *     the toggle itself is no longer what reveals the gesture), then the send
 *     control labelled for exactly what it will send ("Nothing to add" at
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
  // Chat-style order (the Tray, CONTEXT.md): the queued list first, the
  // composer next, the send bar last -- a reviewer scanning the Tray meets
  // what is already said before the box for saying more, and the send
  // control settles at the reviewer's hand instead of above an
  // arbitrarily long list. What keeps the composer and send bar out of the
  // scrolling region is unaffected by this markup order (src/styles.mjs,
  // above `.page-comments`): `.comment-list-wrap` alone is the explicit
  // `flex: 1 1 auto; min-height: 0` that opts INTO shrinking, `.page-send-bar`
  // is the explicit `flex: none` that refuses to, and `.comment-target`/
  // `.comment-form` hold their own size the same way `.page-send-bar` does
  // without saying so -- neither sets a `flex` property at all, so each falls
  // back to a flex item's automatic minimum size (its own content height),
  // which is exactly as much a floor as an authored `flex: none` for a
  // container with only one item willing to shrink below it.
  return `
    <div class="comment-list-wrap"><div class="comment-list" id="comment-list-${escAttr(blockId)}">${commentItemsHtml(blockId, commentsByBlock)}</div></div>
    <div class="comment-target" id="comment-target-${escAttr(blockId)}">commenting on: whole block</div>
    <form class="comment-form" id="comment-form-${escAttr(blockId)}" data-block-id="${escAttr(blockId)}" data-anchor-kind="block">
      <input type="text" placeholder="Add a comment"${showHint ? ` aria-describedby="${hintId}"` : ''}${historical ? ' disabled' : ''}>
      <button type="submit"${historical ? ' disabled' : ''}>Add</button>
    </form>
    <div class="page-send-bar" data-round="${round.n}">
      ${hint}
      <button type="button" class="btn-discuss page-discuss-btn" data-round="${round.n}"${historical ? ' disabled' : ''}>Discuss in chat</button>
      <button type="button" class="btn-send page-send-btn" data-round="${round.n}"${historical ? ' disabled' : ''}>${escHtml(label)}</button>
    </div>`;
}

/** A raw HTML stage, for hand-mocked UI previews with no source file — the one
 * context kind passed by value (see PROTOCOL.md Blocks). Rendered inside a
 * sandboxed iframe so the mock's own markup/CSS/script never leaks into or
 * clashes with the board page — including its SCRIPT, not merely its CSS and
 * markup, since `allow-same-origin` was dropped (see the stage-channel comment
 * above stageAgentScript): the frame's browsing context is genuinely
 * cross-origin from the daemon's own, so `contentDocument`/
 * `contentWindow.document` are unreachable from the parent, and element-level
 * click-to-comment goes over the `stageAgentScript` postMessage channel instead.
 * `pin-layer` is an empty, absolutely positioned sibling over the iframe that
 * src/ui.mjs populates with numbered pins for `dom` anchors, positioned from
 * geometry the stage itself reports (never written to here, since that needs a
 * real, live DOM).
 *
 * `fullpage`: this stage is the whole board (ADR.md entry 33), so it renders
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
 * of what already fills the viewport. The send bar is the
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
  // so the srcdoc built here is the SAME for both.
  //
  // STAGE_MARGIN_RESET carries no colour at all, only the margin/padding reset, so
  // html/body stay transparent and the parent-controlled `--stage-bg`
  // (`.html-stage`, src/styles.mjs) still shows through wherever the mock itself
  // paints nothing -- without the reset the UA default `body { margin: 8px }`
  // shows that background through an 8px gutter on every side of every
  // hand-authored mock.
  //
  // It is deliberately a LEADING <style> tag, not an explicit <html><head>...
  // </head><body>...</body></html> wrapper. A real browser only hoists a leading
  // run of head-only elements (HEAD_ONLY_TAGS -- style/script/meta/link/title/
  // base) out of `document.body` when the srcdoc is parsed as the bare fragment it
  // actually is (see src/anchor.mjs's own HEAD_ONLY_TAGS comment). An explicit
  // `<body>` opened before block.html's own leading `<style>` -- the ordinary case
  // for a mock that styles itself -- stops that hoist dead: once body is
  // genuinely, explicitly open, the HTML parsing algorithm inserts a subsequent
  // style/script tag as an ordinary CHILD of body instead of reopening head for
  // it, which shifts every `dom`-anchor ref index by one and breaks exactly the
  // mocks this exists to support (test/check-click.mjs's C2 check fails hard on an
  // explicit-body wrapper here). A leading `<style>` has no such cost: it is
  // itself the first element of that same head-only run, so it hoists out of body
  // alongside a mock's own leading `<style>`, in encounter order, and a <style>
  // element's rules apply wherever it ends up in the tree regardless.
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
  // Anything that is not `open` is history: `sent`, and — since ADR 69 — `abandoned`,
  // the round of a conversation that declared a boundary and walked away
  // (`abandonOpenRounds`, src/board.mjs). Asked as "is it still open" rather than "is it
  // sent" so a third terminal state does not silently render its widgets live again;
  // identical for every board written before that state existed, which only ever carry
  // `open` or `sent`.
  const historical = !!(round && round.status !== 'open');
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

/** The questions-left pill's own count: how many of the OPEN round's
 * top-level questions are still outstanding, at
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

// A closed round owes nothing, whichever way it closed: sent, or abandoned by a
// conversation that declared a boundary (ADR 69). The pager's dot accuses the reviewer of
// stalling, so it must come off a round nobody can answer any more. Its twin in
// src/ui.mjs asks the same question the same way.
function roundOwesAnswer(board, round) {
  if (!round || round.status !== 'open') return false;
  return board.blocks.some(b => b.round === round.n && b.kind === 'question');
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
 * the same rule the index badge counts by, so a page-board
 * round -- open forever, since nothing sends it -- is never dotted as though
 * the reviewer were holding it up. */
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

/** Render a complete, self-contained HTML page for `board`. Pure function of the
 * board JSON: same input, same output, every time. Blocks are grouped by round
 * (renderRoundSection) rather than flattened, and each round is a PAGE of this
 * board (ADR.md entry 42): every round is rendered, exactly one carries
 * `round-current` and the stylesheet shows only that one, so a follow-up round is
 * a page flip away rather than a scroll away. Every comment is run through
 * resolveComment exactly once here (`resolvedComments`), and that single verdict
 * feeds both the server-rendered per-block comment list AND the `#board-data`
 * payload src/ui.mjs hydrates pins from — one source of truth for "does this
 * anchor still resolve", not two independently-computed ones that could disagree.
 * src/server.mjs's SSE push payloads build `boardForClient` the same way, for the
 * same reason — see "SSE events" in PROTOCOL.md.
 *
 * The send bar carries BOTH ways out of a round: `#send-btn` posts
 * `action:'send'`, `#discuss-btn` posts `action:'discuss'` with whatever is
 * filled in right now — partial answers are the point — and tells the agent to
 * stop posting boards. Both live inside the one `.send-bar`, which
 * `body.readonly` hides wholesale (src/styles.mjs), so the standalone file://
 * archive has neither. `#questions-left-pill` is nested inside
 * that same `.send-bar` so it inherits the readonly hiding for free rather than
 * earning a second CSS rule, and leaves the bar's own last-child position in
 * `.board-shell` untouched; this function renders only its first-paint count and
 * label, and src/ui.mjs is what makes it live and click-navigable.
 *
 * Two further stylesheet rules hide the bar rather than this function dropping
 * its markup. `body.page-board .send-bar { display: none; }` (ADR.md entry 44):
 * for a board that never becomes awaited, or whose one page round is not the
 * newest, this bar is still the only route a queued comment has off the page — a
 * comment left there rides the next round's submit, and that round arrives over
 * SSE into THIS document as a new page, which the reviewer flips to and sends
 * from. Deleting the markup would strand both. An AWAITED page round
 * (ADR.md entry 45) gains its own second send control instead,
 * `.page-send-bar` inside `.page-comments` (renderPageCommentPanel, below), which
 * posts to its OWN round rather than "the latest unsent one" this bar always
 * means; the two kickers' controls are a third case and ARE dropped outright on a
 * page round (renderHtmlBlock). `body.sent-page .send-bar` is the other: a sent
 * round is a page you can still flip back to, and it is read-only there (ADR.md
 * entry 42), while the bar's own buttons sit OUTSIDE any round section, so
 * nothing that disables a sent round's widgets ever reaches them; src/ui.mjs's
 * goToRound disables them too.
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
 * board and turned on by src/ui.mjs's `.visible` class alone. */
export function renderBoardPage(board) {
  const resolvedComments = resolveComments(board, board.comments);
  const commentsByBlock = groupCommentsByBlock(resolvedComments);
  // The page-board layout (ADR.md entries 32 and 33) is carried two ways: down
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
  // `stripDaemonOnly` (src/board.mjs) drops the stranded rule's own bookkeeping for a
  // second, independent reason: the daemon writes that record WITHOUT re-rendering the
  // page, so anything of it that reached this payload would make the served markup
  // disagree with `pages/<id>.html` on disk. See that function's own comment.
  const { cwd: _cwd, ...boardForClient } = stripDaemonOnly({ ...board, comments: resolvedComments });
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
  // The waiting signal (ADR.md entries 46, 47, 40; ADR 89):
  // `#round-meta` (the header's own pill/meta slot, every board since ticket
  // 03) and `#round-countdown` (the ordinary send bar's) are both
  // first-painted from `roundIsAwaitedOpen` and `round.status` alone --
  // deterministic, no clock -- and left EMPTY when the round in question is
  // open and awaited, exactly the split badge.mjs's own header comment lays
  // out (and src/pomodoro-widget.mjs's precedent for the identical problem):
  // the actual "38m left" figure is a wall-clock fact only src/ui.mjs may
  // compute, filled in at hydrate before the reader can act. The
  // deterministic cases -- Submitted, or closed some other way (never-awaited
  // or its wait lapsed) -- need no such deferral -- neither `submitted` nor
  // `read-only` is a function of the clock at all -- so each renders directly
  // here, the same strings ui.mjs's own pageBoardPillMeta falls back to.
  const initialRound = board.rounds.find(r => r.n === initialRoundInView);
  const initialRoundOpenAwaited = roundIsAwaitedOpen(initialRound);
  // `!fullpage` gates this the same way it gates the read-only title just
  // below -- badge.mjs's own comment on PILL_SUBMITTED_TITLE has the full
  // reasoning: a page board is held off `submitted` at the pill itself, since
  // `initialRound.status` alone cannot prove a page round was never handed to
  // this decision through some path other than the browser's Send control.
  // Status alone, no `fullpage` and no clock -- the identical question
  // src/ui.mjs's refreshPager asks of `roundEntry(currentRound)` to toggle
  // `sent-page`, asked here so the class is on <body> in the served bytes
  // rather than only from hydrate onwards (ADR 101). The two must agree
  // exactly: a first paint that disagreed with the first refreshPager would
  // show the send bar and the comment control for one frame and then take
  // them away.
  const initialRoundSent = !!initialRound && initialRound.status === 'sent';
  const initialRoundSubmitted = !fullpage && initialRoundSent;
  const roundMetaText = initialRoundOpenAwaited ? '' : initialRoundSubmitted ? 'submitted' : 'read-only';
  // The title underneath that word is NOT one string for every board: a
  // Submitted round on an ORDINARY board gets PILL_SUBMITTED_TITLE (see
  // `initialRoundSubmitted` just above). Short of that, a page board's
  // compose/send surface really does go dark the moment it stops being
  // awaited (PILL_READONLY_TITLE, badge.mjs's own comment on it), but an
  // ordinary round with no `wait: true` stays `open` and its send bar stays
  // enabled the whole time -- "commenting is off" would be false directly
  // above a live Send button. badge.mjs's own comment on
  // ROUND_OPEN_UNAWAITED_TITLE has the full reasoning; `initialRound.status`
  // is what src/ui.mjs's pageBoardPillMeta reads for the identical decision
  // at hydrate, kept in step here by hand the same way roundMetaText already is.
  const roundMetaTitle = initialRoundOpenAwaited ? ''
    : initialRoundSubmitted ? PILL_SUBMITTED_TITLE
    : (!fullpage && initialRound && initialRound.status === 'open') ? ROUND_OPEN_UNAWAITED_TITLE : PILL_READONLY_TITLE;
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
  // ADR 98 (widens entry 46): the comment-mode toggle renders only when the
  // round on screen holds at least one Commentable block ('html'/'mermaid',
  // wherever it appears -- roundHasCommentable, src/badge.mjs). Unlike
  // `pageUncommentable` above this is not page-board-specific -- an ORDINARY
  // round of only question/markdown/code blocks is exactly as uncommentable as
  // a never-awaited artifact -- so it is asked of every board, not gated on
  // `fullpage` first. src/ui.mjs's refreshPager re-asks the identical function
  // on every flip, the same split `pageUncommentable`/refreshAwaitDisplay
  // already uses for the awaited-ness half.
  const roundUncommentable = !roundHasCommentable(board.blocks.filter(b => b.round === initialRoundInView));
  // All three commenting-hiding facts ride the same body-class mechanism as
  // `readonly` (QUIRKS.md "Readonly is locked twice"): kept in the markup,
  // hidden structurally by src/styles.mjs rather than omitted, so a page that
  // becomes commentable again (a later round pushed, a flip to a different
  // round) never needs a second element minted for it. Built as a list rather
  // than the old fullpage-only ternary, since `roundUncommentable` and
  // `initialRoundSent` -- unlike `pageUncommentable` -- apply to an ordinary
  // board too.
  const bodyClasses = [
    ...(fullpage ? ['page-board'] : []),
    ...(initialRoundSent ? ['sent-page'] : []),
    ...(pageUncommentable ? ['page-uncommentable'] : []),
    ...(roundUncommentable ? ['round-uncommentable'] : []),
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<title>${escHtml(board.title || 'board')}</title>
${faviconLink}
<script>${themeBootScript}</script>
<link rel="stylesheet" href="${STYLE_ASSET}">
</head>
<body${bodyClasses.length ? ` class="${bodyClasses.join(' ')}"` : ''}>
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
<script defer src="${SCRIPT_ASSET}"></script>
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
 * command, selectable and pasteable — whatever `recoveryCommand` (src/handoff.mjs) the
 * caller hands in. The caller matters here: src/server.mjs's `sendCredentialRefusal`
 * deliberately passes the RELATIVE form (`recoveryCommand(undefined, { absolute: false })`),
 * never the absolute one, because this page renders to any TAB that lands on the read
 * gate — a cross-origin-shaped navigation among them — and the absolute form is a real
 * filesystem path (`/Users/<name>/...` on a stock macOS clone) this function would
 * otherwise print verbatim to a caller the gate could not verify.
 *
 * It renders NOTHING about the request, and nothing about the machine it runs on. No
 * board id, no title, no store contents, not even whether the board exists — the whole
 * point of the gate is that an unauthorized caller learns nothing behind it, and a
 * "board not found" here would leak existence to anything that could enumerate ids; no
 * absolute path or username either, for the same reason. Self-contained (inline style
 * only, no script, no network) so it renders under the same locked-down CSP every board
 * page carries. */
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
