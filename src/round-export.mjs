// A sent round saved as one HTML file: the Download round control on the round's
// chip line, and the pure half of the file it saves. The file is made in the
// browser from the drawn round (src/ui.mjs's downloadRound), so a diagram is
// already SVG and no engine rides in the file; this module holds what needs no
// DOM, so test/check-round-download.mjs reads it in node and src/ui.mjs embeds
// each function's literal source by '.toString()' (the src/badge.mjs discipline:
// src/ui.mjs cannot import src/render.mjs).
//
// Every function below that src/ui.mjs embeds is self-contained: no import, no
// module-scope name, since its text runs in the tab on its own. The one
// exception is PRINT_PAGE_H, which src/ui.mjs embeds beside printScale.

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';

/** The ghost control at the right end of a sent round's chip line. One string for
 * both sides that draw it: src/render.mjs for a round rendered sent, and
 * src/ui.mjs's markRoundHistory for a round that goes sent under an open tab. */
export const ROUND_DOWNLOAD_BUTTON = `<button type="button" class="round-download" title="Save this round as one HTML file">${DOWNLOAD_ICON}Download round</button>`;

/** One decisions-table row per question of the round, in board order:
 * `{ question, pick, note }`, all plain text. `questions` is the round's question
 * blocks (src/badge.mjs's questionBlocks over the round's blocks), `answers` the
 * board's answers by question id. */
export function decisionRows(questions, answers) {
  return (questions || []).map(function (q) {
    var a = (answers && answers[q.id]) || null;
    var pick;
    if (!a || a.status === 'unanswered') pick = 'No answer';
    else if (a.status === 'deferred') pick = 'Deferred';
    else if (Array.isArray(a.choice)) {
      pick = q.widget === 'rank'
        ? a.choice.map(function (label, i) { return (i + 1) + '. ' + label; }).join(', ')
        : a.choice.join(', ');
    } else pick = typeof a.choice === 'string' && a.choice ? a.choice : 'No answer';
    return { question: String(q.prompt || ''), pick: pick, note: a && typeof a.note === 'string' ? a.note : '' };
  });
}

/** `iso` as the reader's own calendar date, YYYY-MM-DD; '' when it is not a date. */
export function exportDate(iso) {
  var d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** The saved file's name: the board's title as a slug, then the round. */
export function exportFileName(title, n) {
  var slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return (slug || 'board') + '-round-' + n + '.html';
}

/** The height, in px, of the one printed page a taller diagram or mock is fitted to:
 * Letter's, the shorter paper, under Chrome's default 0.4in margins, less a little
 * for rounding. */
export const PRINT_PAGE_H = 960;

/** How far a printed page's height shrinks a mock 'height' px tall as drawn on the
 * board: not at all unless the mock is taller than one page, then to that page. A
 * mock no taller than a page prints as it always did, at the width of its place in
 * the file. EXPORT_CSS's print half shrinks a taller one further where its holder's
 * width is the tighter limit. */
export function printScale(height) {
  return height > PRINT_PAGE_H ? PRINT_PAGE_H / height : 1;
}

/** The file itself. `css` is the board's stylesheet as text, so the drawn blocks
 * in `contentHtml` read as they did on the board; EXPORT_CSS lays out the rest
 * and prints it. The policy admits styles, fonts and images inline and nothing
 * else, so even a script that slipped past the strip could not run, and nothing
 * reaches the network. */
export function exportDocument(o) {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var roundName = 'Round ' + o.roundN;
  var subtitle = o.roundTitle && o.roundTitle !== o.title ? ' · ' + esc(o.roundTitle) : '';
  var rows = (o.rows || []).map(function (r) {
    return '<tr><td class="export-q">' + esc(r.question) + '</td><td class="export-pick">' + esc(r.pick)
      + '</td><td class="export-note">' + esc(r.note) + '</td></tr>';
  }).join('');
  var decisions = rows
    ? '<table class="export-decisions"><thead><tr><th>Question</th><th>Pick</th><th>Note</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<p class="export-empty">This round asked no questions.</p>';
  var sent = o.sentDate ? '<span>Sent <b>' + esc(o.sentDate) + '</b></span>' : '';
  return '<!DOCTYPE html>\n<html lang="en" data-theme="light">\n<head>\n<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; media-src data:">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + esc(o.title) + ', ' + roundName + '</title>\n'
    + '<style>\n' + String(o.css || '').replace(/</g, '\\3c ') + '\n</style>\n'
    + '<style>\n' + o.exportCss + '\n</style>\n</head>\n'
    + '<body class="round-export">\n<main class="export-doc">\n'
    + '<header class="export-head"><div class="export-from">From claude-board</div><h1 class="export-title">' + esc(o.title) + '</h1>'
    + '<div class="export-meta"><span><b>' + roundName + '</b>' + subtitle + '</span>' + sent + '</div></header>\n'
    + '<h2 class="export-section">Decisions</h2>\n' + decisions + '\n'
    + '<h2 class="export-section">Round content</h2>\n'
    + '<section class="round round-current export-round">\n' + o.contentHtml + '\n</section>\n'
    + '</main>\n</body>\n</html>\n';
}

/** Layout A, decisions first, over the board's own stylesheet; light, since a
 * file is printed. The print half keeps a card, a question, a diagram, a stage and
 * a decisions row each on one page, and keeps the marks a reader needs (the picked
 * option's tint, the card edges) when the browser would drop backgrounds. A
 * diagram taller than a page is drawn smaller to fit one (PRINT_PAGE_H). A mock taller than a page (its holder is '.export-fit',
 * carrying the frame's width and height on the board and printScale's answer)
 * keeps the board's width, so it lays out as it was drawn, and is scaled into
 * its holder: by printScale's answer or by the holder's own width over the
 * frame's, whichever is smaller. That second ratio is two lengths, which CSS
 * divides only through tan(atan2()); '100cqw' is the holder's width, read off
 * the '.stage-wrap' around it. A browser with neither container units nor
 * the trigonometric functions fits no mock: it would hold the board's width
 * with nothing to scale it by, its right edge clipped, so there the frame
 * prints at the width of its place, as any shorter mock does. A card taller than a page breaks between its
 * pieces (options, comments, paragraphs, table rows, notes), each kept whole,
 * and never inside a line. Code prints whole: paper cannot scroll, so its box
 * loses the board's height cap (an inline height, where the board has turned
 * the cap into one) and a long line wraps. */
export const EXPORT_CSS = `
body.round-export { min-height: 0; padding: 40px 24px; background: var(--bg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body.round-export::before { display: none; }
.export-doc { max-width: 1065px; margin: 0 auto; }
.export-head { padding-bottom: 20px; border-bottom: 1px solid var(--hairline-2); margin-bottom: 28px; }
.export-from { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.export-title { font-size: 22px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
.export-meta { font-size: 13px; color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; }
.export-meta b { color: var(--ink-2); font-weight: 600; }
.export-section { font-size: 15px; font-weight: 650; margin: 36px 0 14px; display: flex; align-items: center; gap: 10px; break-after: avoid; }
.export-section::after { content: ""; flex: 1; height: 1px; background: var(--hairline-2); }
.export-decisions { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 13px;
  background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.export-decisions th, .export-decisions td { text-align: left; vertical-align: top; padding: 12px 16px; border-bottom: 1px solid var(--hairline); overflow-wrap: anywhere; }
.export-decisions tr:last-child td { border-bottom: none; }
.export-decisions th { background: var(--panel-2); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.export-decisions th:first-child { width: 40%; }
.export-q { color: var(--ink-2); }
.export-pick { font-weight: 650; color: var(--ink); white-space: pre-wrap; }
.export-note { color: var(--muted); font-style: italic; white-space: pre-wrap; }
.export-empty { color: var(--muted); }
.export-round { gap: 16px; }
.export-round .round-history .block, .export-round .block { background: var(--panel); }
.export-round .folded > .fold-body { max-height: none; overflow: visible; -webkit-mask-image: none; mask-image: none; }
.export-round .card-choice { cursor: default; opacity: 1; }
.export-round .opt-check { display: none; }
.export-round .card-choice.selected, .export-round .variant-card.selected { border-color: var(--good); background: var(--good-soft); box-shadow: inset 3px 0 0 var(--good); }
.export-round .card-choice.selected .opt-label::before, .export-round .variant-card.selected .opt-label::before { content: "\\2713  "; color: var(--good); }
.export-round .export-text { white-space: pre-wrap; font-size: 13px; color: var(--ink); background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: 12px 14px; }
.export-round .export-note-box { font-size: 12.5px; color: var(--ink-2); background: var(--accent-soft); border: 1px solid var(--hairline);
  border-radius: var(--r-sm); padding: 8px 12px; white-space: pre-wrap; }
.export-round .export-note-tag { display: block; font-weight: 650; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 3px; }
.export-round .html-stage { max-height: none; }
.export-round .export-missing { color: var(--muted); font-style: italic; font-size: 12.5px; }
.export-round .comment-list { display: block; }
.export-round .comment-list-wrap { max-height: none; overflow: visible; }
@media print {
  body.round-export { padding: 0; background: #fff; }
  .export-round .block { box-shadow: none; }
  .export-round .block, .export-round .question-block, .export-round .card-choice, .export-round .variant-card,
  .export-round .stage-wrap, .export-round pre.mermaid, .export-round .comment-item, .export-decisions tr,
  .export-round p, .export-round li, .export-round tr, .export-round .export-text, .export-round .export-note-box { break-inside: avoid; }
  .export-round .card-head, .export-round .question-prompt { break-after: avoid; }
  .export-round pre.mermaid svg { max-height: ${PRINT_PAGE_H}px; }
  .export-round pre:not(.mermaid) { height: auto !important; max-height: none; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
  .export-round .stage-wrap { container-type: inline-size; }
  .export-round .export-frame { break-inside: avoid; }
  @supports (width: 1cqw) and (rotate: atan2(1px, 1px)) {
    .export-round .export-fit { --export-fit: min(var(--export-scale), tan(atan2(100cqw, var(--export-w))));
      height: calc(var(--export-h) * var(--export-fit)); overflow: hidden; }
    .export-round .export-fit > iframe.html-stage { width: var(--export-w); max-width: none;
      transform: scale(var(--export-fit)); transform-origin: 0 0; }
  }
}
`;
