// Builds the sample board shipped as examples/sample-board.json and
// examples/sample-board.html: a single fictional review -- a kitchen-display
// app's ticket-routing redesign -- that exercises every content block kind,
// every widget, an answered state for each, all three comment-anchor flavors
// and the round pager's two shapes (ADR.md entries 33/42), so a reader can see
// what a filled-in board looks like without cloning the repo or installing
// anything.
//
// Round 1 is a PAGE BOARD: one `html` block and nothing else, the rendered
// kitchen-display mockup the rest of the review is about. Round 2 is the
// block gallery -- markdown, mermaid, code, compare and every question widget,
// each answered, reading as the follow-up discussion about round 1's artifact.
// The board opens on round 2 (its newest round), one chevron ahead of the
// artifact that started the thread.
//
// A page board is never sent (ADR.md entry 35: "a rendered page is a thing you
// read, not a form you submit"). That is refused in the browser -- src/ui.mjs's
// setSendBarEnabled and submitBoard both re-check the round's shape, and
// src/styles.mjs hides the send bar outright -- not by the daemon, which does
// not gate a submit on round shape at all. Round 1 here simply never receives a
// submit call and stays `open` for good. The comment pinned inside it travels
// instead in round 2's own submit, exactly as entry 35 describes: "an
// undelivered comment rides the thread's next packet."
//
// `buildSampleBoard()` goes through the real constructors (`createBoard`,
// `addRound`, `applySubmit` from src/board.mjs) rather than hand-assembling a
// JSON literal -- that's what proves the sample board is a document those
// constructors would actually produce and accept, the same validation a
// posted board goes through, not a shape the daemon would reject.
//
// createBoard/addRound/applySubmit mint real wall-clock timestamps and
// createBoard mints a random board id and thread id -- everything else on the
// board is already deterministic (block ids come from a plain per-kind
// counter, KIND_LETTER + nextBlockId in src/board.mjs; every sha is a plain
// hash of fixed text). buildSampleBoard() pins exactly those nondeterministic
// fields to fixed literals after construction, which is what makes two runs
// produce byte-identical JSON -- test/check-sample-board.mjs asserts that.
//
// Run directly (`node examples/sample-board.mjs`) to regenerate both
// committed files from this script.

import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Every html-stage block below carries its own inline <style> so it renders as
// a real UI mock rather than unstyled browser default (Times New Roman text,
// a grey button in the corner of an empty box) -- the stage is the one place
// this tool's whole "what the page looks like" premise is on display. A
// LEADING <style> tag hoists out of the iframe body when the srcdoc is
// parsed (HEAD_ONLY_TAGS, src/anchor.mjs's own comment on this same fact) --
// so it costs nothing in the step-chain a `dom` anchor's `ref` counts against;
// every ref below is computed against the markup AFTER that hoist.
//
// Every mock takes its vertical spacing from `body`'s own PADDING, or from a
// HORIZONTAL-only margin (`margin: 0 auto`) on a wrapper, never from a
// VERTICAL margin on body's direct child, and that is load-bearing twice
// over. A vertical margin on body's only child collapses through body
// (nothing on body contains it), which (a) moves `document.body`'s own box
// down by that much, and the stage reports pin positions relative to body
// while the pin layer is aligned to the iframe VIEWPORT -- so every pin in the
// stage draws that many px high, and a comment anchored to the Confirm button
// lands on the chip above it; and (b) is silently absent from
// `document.body.scrollHeight`, which src/ui.mjs's handleStageHeight uses to
// size a stage under a fixed-height + overflow:hidden rule -- undercounting the
// height and clipping the mock. Padding never collapses and is always counted,
// so it avoids both. (A page-board stage is exempt from the sizing half: its
// frame is a constant 100vh and ignores the height the artifact reports --
// src/styles.mjs. The pin-offset half still bites there, which is what the
// dom-anchored comment below depends on.) No `vh` unit appears anywhere below:
// an artifact must size from its own content, never from the viewport it
// happens to be shown in, and that rule binds outside a page board too, where
// the frame IS derived from what the stage reports (skills/claude-board/SKILL.md).

// The round-1 page board: a full kitchen-display screen, several tickets in
// flight at once -- what the redesign in round 2 is actually discussing, not
// one card in isolation. `ref: '1.2.1.3.1'`, the target of the dom-anchor
// comment below: this stage's only body child is `.kd-board` (1), whose 2nd
// child is `.kd-grid` (2), whose 1st child is the #482 `.ticket` (1), whose
// 3rd child is `.actions` (3), whose only child is the `<button>` (1) -- see
// htmlBodyRootFrom/resolveAtRoot (src/anchor.mjs).
//
// The 104px top padding is the fixed header's gutter, not taste. A page board
// puts the board header at `position: fixed; top: 0` over a stage that starts
// at document y=0 (src/styles.mjs, `body.page-board` rules), so the first ~77px
// of any artifact is painted over -- and the header only condenses once the
// stage has scrolled past 24px, which an artifact shorter than the viewport
// never does. An artifact that starts its own content at the top loses it.
const KITCHEN_BOARD_HTML = `<style>
  body { margin: 0; padding: 104px 24px 32px; font-family: system-ui, sans-serif; background: #111827; }
  .kd-board { max-width: 900px; margin: 0 auto; }
  .kd-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; color: #f9fafb; }
  .kd-head h1 { font-size: 20px; margin: 0; font-weight: 700; }
  .kd-head .clock { font-size: 13px; opacity: .75; font-variant-numeric: tabular-nums; }
  .kd-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .ticket { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.25); overflow: hidden; border: 1px solid #e2e2e2; }
  .ticket-head { background: #1f2937; color: #fff; padding: 14px 18px; display: flex; justify-content: space-between; align-items: baseline; }
  .ticket-head .num { font-size: 18px; font-weight: 700; }
  .ticket-head .table { font-size: 13px; opacity: .8; }
  .ticket-body { padding: 14px 18px; }
  .item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #e5e5e5; font-size: 14px; color: #111; }
  .item:last-child { border-bottom: none; }
  .chip { display: inline-block; margin: 10px 0 4px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .chip.prep { background: #fef3c7; color: #92400e; }
  .chip.ready { background: #dcfce7; color: #166534; }
  .chip.rush { background: #fee2e2; color: #991b1b; }
  .chip.served { background: #e5e7eb; color: #374151; }
  .actions { padding: 12px 18px 18px; }
  button { width: 100%; padding: 10px 0; border: none; border-radius: 8px; background: #2563eb; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { background: #9ca3af; cursor: default; }
</style>
<div class="kd-board">
  <div class="kd-head"><h1>Kitchen Display — Dinner Rush</h1><span class="clock">6:42 PM · 4 open tickets</span></div>
  <div class="kd-grid">
    <div class="ticket">
      <div class="ticket-head"><span class="num">#482</span><span class="table">Table 6</span></div>
      <div class="ticket-body">
        <div class="item"><span>Grilled salmon</span><span>x1</span></div>
        <div class="item"><span>Caesar salad</span><span>x1</span></div>
        <div class="item"><span>Sparkling water</span><span>x2</span></div>
        <span class="chip prep">In prep</span>
      </div>
      <div class="actions"><button>Confirm</button></div>
    </div>
    <div class="ticket">
      <div class="ticket-head"><span class="num">#481</span><span class="table">Table 9</span></div>
      <div class="ticket-body">
        <div class="item"><span>Seared tuna</span><span>x1</span></div>
        <div class="item"><span>Miso soup</span><span>x1</span></div>
        <span class="chip rush">Rush</span>
      </div>
      <div class="actions"><button>Confirm</button></div>
    </div>
    <div class="ticket">
      <div class="ticket-head"><span class="num">#483</span><span class="table">Table 2</span></div>
      <div class="ticket-body">
        <div class="item"><span>Roast chicken</span><span>x2</span></div>
        <div class="item"><span>House salad</span><span>x1</span></div>
        <span class="chip ready">Ready for pickup</span>
      </div>
      <div class="actions"><button>Mark served</button></div>
    </div>
    <div class="ticket">
      <div class="ticket-head"><span class="num">#479</span><span class="table">Table 11</span></div>
      <div class="ticket-body">
        <div class="item"><span>Margherita pizza</span><span>x1</span></div>
        <span class="chip served">Served</span>
      </div>
      <div class="actions"><button disabled>Served</button></div>
    </div>
  </div>
</div>`;

// The compare block: the SAME ticket (#482), before and after the redesign --
// what round 2 is actually discussing, not two near-empty boxes.
const TICKET_BEFORE_HTML = `<style>
  body { margin: 0; padding: 16px 0; font-family: system-ui, sans-serif; background: #f3f4f6; }
  .ticket { max-width: 300px; margin: 0 auto; background: #fff; border: 1px solid #d1d5db; padding: 10px 12px; font-size: 12px; line-height: 1.5; color: #374151; }
  .ticket p { margin: 2px 0; }
  .head { font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #111; }
  button { margin-top: 8px; padding: 6px 10px; font-size: 12px; background: #e5e7eb; border: 1px solid #9ca3af; border-radius: 4px; color: #111; cursor: pointer; }
</style>
<div class="ticket">
  <div class="head">Order #482 — Table 6 — Placed 6:42 PM — Status: Awaiting confirmation</div>
  <p>1x Grilled salmon</p>
  <p>1x Caesar salad</p>
  <p>2x Sparkling water</p>
  <p>Estimated prep time: 12 minutes</p>
  <button>Confirm order now, please</button>
</div>`;

const TICKET_AFTER_HTML = `<style>
  body { margin: 0; padding: 16px 0; font-family: system-ui, sans-serif; }
  .ticket { max-width: 260px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.15); overflow: hidden; border: 1px solid #e2e2e2; }
  .head { background: #1f2937; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; }
  .body { padding: 10px 14px; font-size: 13px; color: #111; }
  .item { display: flex; justify-content: space-between; padding: 4px 0; }
  button { width: 100%; padding: 9px 0; border: none; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
</style>
<div class="ticket">
  <div class="head"><span>#482</span><span>Table 6</span></div>
  <div class="body">
    <div class="item"><span>Grilled salmon</span><span>x1</span></div>
    <div class="item"><span>Caesar salad</span><span>x1</span></div>
    <div class="item"><span>Sparkling water</span><span>x2</span></div>
  </div>
  <button>Confirm</button>
</div>`;

// The two choose-between-rendered-variants options: each rendered so it
// actually looks like what its own description claims, since the whole point
// of this widget is choosing between rendered variants.
const LAYOUT_COMPACT_HTML = `<style>
  body { margin: 0; padding: 16px 0; font-family: system-ui, sans-serif; }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; max-width: 340px; margin: 0 auto; font-size: 14px; color: #111; }
  .row b { font-weight: 700; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; }
</style>
<div class="row"><b>#482</b><span class="dot"></span><span>Table 6</span><span class="dot"></span><span>3 items</span></div>`;

const LAYOUT_SPACIOUS_HTML = `<style>
  body { margin: 0; padding: 16px 0; font-family: system-ui, sans-serif; }
  .card { max-width: 340px; margin: 0 auto; padding: 18px; background: #fff; border: 1px solid #e2e2e2; border-radius: 10px; }
  .line { padding: 6px 0; font-size: 15px; color: #111; border-bottom: 1px solid #f0f0f0; }
  .line:last-child { border-bottom: none; }
  .line.title { font-size: 18px; font-weight: 700; }
</style>
<div class="card">
  <div class="line title">Order #482</div>
  <div class="line">Table 6</div>
  <div class="line">3 items</div>
</div>`;

export function buildSampleBoard() {
  // Round 1: the page board. One `html` block and nothing else -- a stats
  // line or a question posted beside it would silently cost it the fullpage
  // layout (ADR.md entry 33, skills/claude-board/SKILL.md).
  const board = createBoard({
    title: 'feature/kitchen-routing-v2',
    cwd: null,
    blocks: [
      { kind: 'html', html: KITCHEN_BOARD_HTML },
    ],
  });

  const htmlBlock = board.blocks.find(b => b.kind === 'html');

  // Round 1 is never sent -- ADR.md entry 35: a page board asks nothing, so
  // there is no packet for a submit to close out, and `applySubmit` is never
  // called for it. It stays `open` for good.

  // Round 2: the block gallery, and the newest round -- the board opens here,
  // reading as the follow-up discussion about the artifact one chevron back.
  addRound(board, {
    title: 'Routing walkthrough',
    blocks: [
      {
        kind: 'markdown',
        text: [
          '# Order-routing redesign',
          '',
          "The kitchen display one page back is the mockup. Three things change for the pass, and the routing rewrite underneath them is what this round is asking about:",
          '',
          '- Fewer manual status updates per ticket',
          '- A single "Ready for pickup" state visible to front-of-house',
          '- Rush tickets float to the top automatically',
          '',
          '| Station | Avg. ticket time (today) | Avg. ticket time (proposed) |',
          '| --- | --- | --- |',
          '| Grill | 46s | 33s |',
          '| Salad | 28s | 24s |',
          '| Expo | 19s | 15s |',
        ].join('\n'),
      },
      {
        kind: 'mermaid',
        text: 'flowchart LR\n  Placed[Order placed] --> Prepping[In prep] --> Ready[Ready for pickup] --> Served[Served]',
      },
      {
        kind: 'code',
        lang: 'javascript',
        text: [
          'function priorityScore(ticket) {',
          '  const waitMs = Date.now() - ticket.placedAt;',
          '  const rushBonus = ticket.rush ? 500 : 0;',
          '  return waitMs + rushBonus;',
          '}',
        ].join('\n'),
      },
      {
        kind: 'compare',
        left: {
          label: 'Before',
          block: { kind: 'html', html: TICKET_BEFORE_HTML },
        },
        right: {
          label: 'After',
          block: { kind: 'html', html: TICKET_AFTER_HTML },
        },
      },
      {
        kind: 'question',
        prompt: 'Does the kitchen display in round 1 match the routing flow (Placed -> In prep -> Ready -> Served) we discussed?',
        widget: 'single',
        context: [
          {
            kind: 'markdown',
            text: 'Background: average ticket time today is 31 seconds across the three prep stations (grill, salad, expo).',
          },
        ],
        options: [
          { label: 'Yes, ship it' },
          { label: 'Close, one tweak needed' },
          { label: 'No, rework it' },
        ],
      },
      {
        kind: 'question',
        prompt: 'Which stations need their ticket displays updated to match the round 1 mockup?',
        widget: 'multi',
        options: [
          { label: 'Grill' },
          { label: 'Salad' },
          { label: 'Expo' },
          { label: 'Bar' },
        ],
      },
      {
        kind: 'question',
        prompt: 'Anything else the kitchen team should flag before we ship?',
        widget: 'text',
      },
      {
        kind: 'question',
        prompt: 'Rank these three palettes for the status chips (In prep / Rush / Ready for pickup) by legibility under kitchen pass lighting, most legible first. The display one page back uses the first of them.',
        widget: 'rank',
        options: [
          { label: 'High-contrast' },
          { label: 'Pastel' },
          { label: 'Monochrome' },
        ],
      },
      {
        kind: 'question',
        prompt: 'Which ticket-card layout reads faster at a glance?',
        widget: 'choose-between-rendered-variants',
        options: [
          {
            label: 'Layout A',
            description: 'Compact, single line',
            block: { kind: 'html', html: LAYOUT_COMPACT_HTML },
          },
          {
            label: 'Layout B',
            description: 'Spacious, three lines',
            block: { kind: 'html', html: LAYOUT_SPACIOUS_HTML },
          },
        ],
      },
    ],
  });

  const mermaidBlock = board.blocks.find(b => b.round === 2 && b.kind === 'mermaid');
  const singleQuestion = board.blocks.find(b => b.round === 2 && b.kind === 'question' && b.widget === 'single');
  const multiQuestion = board.blocks.find(b => b.round === 2 && b.kind === 'question' && b.widget === 'multi');
  const textQuestion = board.blocks.find(b => b.round === 2 && b.kind === 'question' && b.widget === 'text');
  const rankQuestion = board.blocks.find(b => b.round === 2 && b.kind === 'question' && b.widget === 'rank');
  const variantQuestion = board.blocks.find(b => b.round === 2 && b.kind === 'question' && b.widget === 'choose-between-rendered-variants');

  applySubmit(board, {
    action: 'send',
    answers: [
      {
        id: singleQuestion.id,
        status: 'answered',
        choice: 'Close, one tweak needed',
        note: 'Add a Recall step from Ready back to Prepping for remakes.',
      },
      {
        id: multiQuestion.id,
        status: 'answered',
        choice: ['Grill', 'Expo'],
        note: 'Bar can wait until next sprint.',
      },
      {
        id: textQuestion.id,
        status: 'answered',
        choice: 'Make sure the Recall state also resets the rush-bonus timer, or repeat rush tickets will always sort to the top.',
        note: '',
      },
      {
        id: rankQuestion.id,
        status: 'answered',
        choice: ['High-contrast', 'Monochrome', 'Pastel'],
        note: 'Pastel washes out completely under the heat-lamp lighting.',
      },
      {
        id: variantQuestion.id,
        status: 'answered',
        choice: 'Layout A',
        note: '',
      },
    ],
    comments: [
      // Whole-block comment, on a commentable (mermaid) block.
      { blockId: mermaidBlock.id, anchor: { kind: 'block' }, text: "This matches the walkthrough from Tuesday's stand-up. Nice work." },
      // Element-level comment pinned inside round 1's page-board html stage:
      // `ref: '1.2.1.3.1'` is KITCHEN_BOARD_HTML's own comment above -- the
      // #482 ticket's Confirm button. `hint` is the button's own collapsed
      // text, which is what resolveComment's identity check compares against.
      // ADR.md entry 35: a comment left on a page board (round 1, never sent)
      // rides the thread's NEXT packet -- this one travels in round 2's submit
      // below, even though it is pinned to a round 1 block.
      { blockId: htmlBlock.id, anchor: { kind: 'dom', ref: '1.2.1.3.1', hint: 'Confirm' }, text: "Consider making this button say 'Confirm order' for clarity." },
      // Element-level comment pinned to a mermaid diagram node, by its
      // source-declared node id (mermaidRefResolves, src/anchor.mjs).
      { blockId: mermaidBlock.id, anchor: { kind: 'mermaid', ref: 'Ready' }, text: 'Should Ready also branch to a Recall state if an item comes back?' },
    ],
  }, 2);

  // Pin every nondeterministic field to a fixed literal -- see this file's
  // header comment for why nothing else on the board needs it. Round 1's
  // `sentAt` stays null: it is never sent (see above).
  board.id = 'b_00112233445566778899aabbccddeeff';
  board.thread = 'th_01234567';
  board.createdAt = '2026-07-14T09:12:00.000Z';
  board.updatedAt = '2026-07-15T10:31:00.000Z';
  board.rounds[0].postedAt = '2026-07-14T09:12:00.000Z';
  board.rounds[1].postedAt = '2026-07-15T10:05:00.000Z';
  board.rounds[1].sentAt = '2026-07-15T10:31:00.000Z';
  // round 2 is awaited (it carries a question), so mintAwait stamped its own
  // awaitDeadline from the REAL Date.now() at generation time -- pin it to the
  // pinned postedAt above plus the 40-minute default (src/board.mjs
  // DEFAULT_AWAIT_TIMEOUT_MS) so this file stays deterministic like every other
  // timestamp here. Round 1 needs no such line: it is a page board round posted
  // without `wait`, so it is never awaited and its awaitDeadline is already the
  // fixed literal `null`.
  board.rounds[1].awaitDeadline = '2026-07-15T10:45:00.000Z';
  for (const c of board.comments) c.createdAt = '2026-07-15T10:31:00.000Z';

  return board;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const board = buildSampleBoard();
  const dir = path.dirname(thisFile);
  writeFileSync(path.join(dir, 'sample-board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(dir, 'sample-board.html'), renderBoardPage(board), 'utf8');
  console.log('wrote examples/sample-board.json and examples/sample-board.html');
}
