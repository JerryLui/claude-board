// A round saved as one HTML file, sent or not: the Download round control on a
// question round's chip line and, for a round drawn full page, in the top strip;
// one mock or diagram saved alone from its Pull-out; and the pure half of the
// file each saves. Two kinds of file (ADR.md entry 154). A question round's, and
// one diagram's, is made in the browser from the drawn round (src/ui.mjs's
// downloadRound), so a diagram is already SVG, a mock inside it is a still copy
// and the file holds no script at all. A mock saved alone, from its Pull-out or
// as the one mock of a round drawn full page, is the mock's own page: its source
// as its stage holds it, scripts and all, under a policy that admits no file on
// the reader's disk and the diagram library's text where the mock draws a
// diagram (stageOwnSource, mockDocument). This module holds what needs no
// DOM, so test/check-round-download.mjs reads it in node and src/ui.mjs embeds
// each function's literal source by '.toString()' (the src/badge.mjs discipline:
// src/ui.mjs cannot import src/render.mjs).
//
// Every function below that src/ui.mjs embeds is self-contained: no import, no
// module-scope name, since its text runs in the tab on its own. The one
// exception is PRINT_PAGE_H, which src/ui.mjs embeds beside printScale.
// STAGE_MARGIN_RESET is handed to the two that need it.

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';

/** Download round's markup, with `extraClass` after its own class where a
 * second place draws it. */
function downloadButton(extraClass, title, attrs = '') {
  return `<button type="button"${attrs} class="round-download${extraClass ? ' ' + extraClass : ''}" title="${title}">${DOWNLOAD_ICON}Download round</button>`;
}

/** The ghost control at the right end of a question round's chip line, sent or
 * not. */
export const ROUND_DOWNLOAD_BUTTON = downloadButton('', 'Save this round as one HTML file');

/** The same control among the top strip's own, for the round in view. It shows
 * only while that round is drawn full page (src/styles.mjs), where the round has
 * no chip line, and stays in the pill once the artifact scrolls under it, there
 * as its icon alone, its label's text sized away but still its name, so its title says
 * the same. */
export const HEAD_DOWNLOAD_BUTTON = downloadButton('head-download', 'Download round');

/** The same control as an item of the phone header's ⋯ menu, for the round in
 * view; it stays open so a note on what it saved shows under it. */
export const MENU_DOWNLOAD_BUTTON = downloadButton('corner-item', 'Download round', ' role="menuitem" data-keep-open');

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

/** The saved file's name: the board's title as a slug, then the round, then
 * `part` where the file holds one mock or diagram of it ('mock-h1'). */
export function exportFileName(title, n, part) {
  var slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  var tail = String(part || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'board') + '-round-' + n + (tail ? '-' + tail : '') + '.html';
}

/** What every stage's `srcdoc` opens with (src/render.mjs's buildStageSrcdoc)
 * and every saved mock's head carries (mockDocument): no page margin, so a mock
 * lays out saved as it does in a stage. Spelled here once; stageOwnSource and
 * mockDocument take it as a parameter, since each runs in the tab on its own. */
export const STAGE_MARGIN_RESET = '<style>html,body{margin:0;padding:0}</style>';

/** A mock's own source, read back out of its stage's `srcdoc`: what
 * src/render.mjs's buildStageSrcdoc wrote around it is taken off again, since a
 * page holds each mock there and nowhere else (ADR.md entry 122). `marginReset`
 * is STAGE_MARGIN_RESET. Answers `{ html, engine }`, and null for text that is
 * not a stage's. `html` is the source as the stage holds it: the text the block
 * was posted with, a line ending of CR or CRLF read as LF, as the browser reads
 * every attribute. `engine` names the diagram library's file where the board
 * gave the stage the library (its tag, then the board's stand-in), and is null
 * for a stage given none. The file is told by its shape, `mermaid-<16 hex>.js`,
 * not by this build's own name: a tab left open across an upgrade holds stages
 * that name the build before, whose file the daemon still serves. A stage whose
 * lent library does not end is no stage this can read, so it answers null too.
 *
 * So does a stage that opens on a script naming a file of that shape with
 * anything after the name but the tag's end and the stand-in's first line as
 * this build writes it:
 * a build that words its stand-in otherwise wrote that stage, this one cannot
 * tell where the stand-in ends, and the board's tag and stand-in saved as the
 * mock's own would be a page that draws nothing.
 *
 * The board's own script is the last thing in every stage and opens the same way
 * nowhere else in itself, so the last such opening is its own, whatever the mock
 * holds. The front has no such mark, so a mock that draws no diagram and itself
 * opens on a script naming a file of that shape is misread, either way: followed
 * by the stand-in's first line it is read as lent the library, and loses its
 * text up to its first closing script tag; followed by anything else it answers
 * null. A mock that opens on any other script, its own or a library under
 * another name or address, is read whole.
 *
 * No script tag is spelled whole here or in mockDocument: this text rides in
 * the page's client script, which a check reads for the files a page names. */
export function stageOwnSource(srcdoc, marginReset) {
  var text = String(srcdoc == null ? '' : srcdoc);
  var open = '<' + 'script', close = '</' + 'script>';
  if (text.slice(0, marginReset.length) !== marginReset) return null;
  var from = marginReset.length, at = from, engine = null;
  function takes(s) {
    if (text.slice(at, at + s.length) !== s) return false;
    at += s.length;
    return true;
  }
  if (takes(open + ' src="')) {
    var name = (/^mermaid-[0-9a-f]{16}\.js/.exec(text.slice(at, at + 27)) || [''])[0];
    at += name.length;
    if (name && takes('">' + close + open + ">(function () {\n  var CB = 'cb-stage', pending")) {
      var end = text.indexOf(close, at);
      if (end < 0) return null;
      engine = name;
      from = end + close.length;
    } else if (name) {
      return null;
    }
  }
  var to = text.lastIndexOf(open + ">(function () {\n  var CB = 'cb-stage';\n");
  if (to < from) return null;
  return { html: text.slice(from, to), engine: engine };
}

/** A mock saved as its own page: `html`, the mock's source as its stage holds
 * it, under a head of four lines, read as UTF-8 whatever opens it: a
 * standards-mode document, the file's policy, and `marginReset`
 * (STAGE_MARGIN_RESET), the head a stage gives it on the board. `engineSource`
 * is the diagram library's text for a mock that draws a diagram, written in as
 * a script ahead of the mock's own, so the mock finds the library on `window`
 * and reaches for no address; null for a mock with none. Nothing else of the
 * board's rides: no stage script, no stylesheet, no address of the daemon.
 *
 * The mock's scripts run wherever the file is opened, and opened from disk
 * that is a `file:` page, which a browser lets load any other file on the disk
 * as a script or an image. The policy is what stops that (ADR.md entry 154): it
 * admits what is written in the file, `data:` and `blob:`, and `https:`
 * addresses, so a library the mock names by web address still loads, and no
 * `file:` address, nor the page's own folder, nor code built from text, which
 * the board's own policy gives a stage none of either. It sits ahead of the
 * library, so it governs every script in the file. It does not stop a script sending what
 * it holds to an `https:` host.
 *
 * The library is written as it is, so its text may hold no script tag, opening
 * or closing: one would end the script early or swallow the page after it. */
export function mockDocument(html, engineSource, marginReset) {
  if (engineSource && /<\/?script/i.test(engineSource)) throw new Error('the diagram library holds a script tag and cannot be written into a file');
  return '<!DOCTYPE html>\n<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'unsafe-inline\' https: data: blob:">\n'
    + marginReset + '\n'
    + (engineSource ? '<' + 'script>' + engineSource + '</' + 'script>\n' : '')
    + String(html == null ? '' : html);
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

/** A round's file. `css` is the board's stylesheet as text, so the drawn blocks
 * in `contentHtml` read as they did on the board; EXPORT_CSS lays out the rest
 * and prints it. The policy admits styles, fonts and images inline and nothing
 * else, so even a script that slipped past the strip could not run, and nothing
 * reaches the network.
 *
 * `o.unsent` is a round not yet sent. Where it asked something, its picks are a
 * draft: the file opens on a line saying so, heads the table as picks so far and
 * marks the round's content, where EXPORT_CSS writes 'picked, unsent' after each
 * picked option. A round that asked nothing has no draft to warn of.
 *
 * `o.only` names a file of one diagram ('One diagram'): `contentHtml` is that
 * diagram alone, under the same head, with no table. (One mock saved alone is
 * mockDocument's, above.) */
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
  var draft = !!o.unsent && !o.only && !!rows;
  var decisions = rows
    ? '<table class="export-decisions"><thead><tr><th>Question</th><th>' + (draft ? 'Pick, unsent' : 'Pick') + '</th><th>Note</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<p class="export-empty">This round asked no questions.</p>';
  var sent = o.only ? '<span>' + esc(o.only) + '</span>'
    : draft ? '<span><b>Not sent</b></span>'
    : o.sentDate ? '<span>Sent <b>' + esc(o.sentDate) + '</b></span>' : '';
  var body = o.only ? ''
    : '<h2 class="export-section">' + (draft ? 'Picks so far, not sent' : 'Decisions') + '</h2>\n' + decisions + '\n'
      + '<h2 class="export-section">Round content</h2>\n';
  return '<!DOCTYPE html>\n<html lang="en" data-theme="light">\n<head>\n<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; media-src data:">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + esc(o.title) + ', ' + roundName + (o.only ? ', ' + esc(o.only).toLowerCase() : '') + '</title>\n'
    + '<style>\n' + String(o.css || '').replace(/</g, '\\3c ') + '\n</style>\n'
    + '<style>\n' + o.exportCss + '\n</style>\n</head>\n'
    + '<body class="round-export">\n<main class="export-doc">\n'
    + (draft ? '<p class="export-unsent-note"><b>Not sent:</b> these picks are a draft, not a decision.</p>\n' : '')
    + '<header class="export-head"><div class="export-from">From claude-board</div><h1 class="export-title">' + esc(o.title) + '</h1>'
    + '<div class="export-meta"><span><b>' + roundName + '</b>' + subtitle + '</span>' + sent + '</div></header>\n'
    + body
    + '<section class="round round-current export-round' + (draft ? ' export-unsent' : '') + '">\n' + o.contentHtml + '\n</section>\n'
    + '</main>\n</body>\n</html>\n';
}

/** Layout A, decisions first, over the board's own stylesheet; light, since a
 * file is printed. An unsent round's picked option wears no settled tint: a dashed
 * edge, and 'picked, unsent' after its label; its question's state chip says
 * unsent too. The print half keeps a card, a question, a diagram, a stage and
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
.export-unsent-note { margin: 0 0 24px; padding: 10px 14px; font-size: 13.5px; color: var(--ink); background: var(--panel-2);
  border: 1.5px solid var(--ink-2); border-radius: var(--r-md); }
.export-unsent .card-choice.selected, .export-unsent .variant-card.selected { border: 1px dashed var(--ink-2); background: var(--panel-2); box-shadow: none; }
.export-unsent .card-choice.selected .opt-label::before, .export-unsent .variant-card.selected .opt-label::before { color: var(--ink-2); }
.export-unsent .card-choice.selected .opt-label::after, .export-unsent .variant-card.selected .opt-label::after { content: " \\00b7  picked, unsent"; white-space: pre;
  font-weight: 500; color: var(--muted); }
.export-unsent .answer-status[data-status] { background: var(--panel-2); color: var(--muted); }
.export-unsent .answer-status[data-status]::after { content: ", unsent"; }
.export-round .export-text { white-space: pre-wrap; font-size: 13px; color: var(--ink); background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: 12px 14px; }
.export-round .export-note-box { font-size: 12.5px; color: var(--ink-2); background: var(--accent-soft); border: 1px solid var(--hairline);
  border-radius: var(--r-sm); padding: 8px 12px; white-space: pre-wrap; }
.export-round .export-note-tag { display: block; font-weight: 650; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 3px; }
.export-round .html-stage { max-height: none; }
.export-round .export-missing { color: var(--muted); font-style: italic; font-size: 12.5px; }
.export-round .comment-list { display: block; }
@media print {
  body.round-export { padding: 0; background: #fff; }
  .export-unsent-note { break-after: avoid; }
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
