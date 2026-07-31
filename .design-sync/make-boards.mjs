// Build display cards for the claude.ai/design project out of the board's OWN
// renderer. claude-board ships no components, so there is nothing for the converter
// to make preview cards from -- but the design agent and anyone browsing the DS pane
// still need to see what this system looks like.
//
// The content below is invented. The MARKUP is not: every card is
// renderBoardPage(createBoard(...)) with the head rebuilt and the client script
// dropped, so the classes are exactly the ones src/render.mjs emits and the CSS is
// the uploaded styles.css. If the board's markup changes, these cards change with it.
//
// Run AFTER package-build.mjs -- the converter wipes --out on every run.
//
//   node .ds-sync/package-build.mjs --config .design-sync/config.json \
//     --node-modules ./.ds-sync/node_modules --out ./ds-bundle
//   node .design-sync/make-boards.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const OUT = resolve(repo, 'ds-bundle');
const GROUP = 'Boards';

const { createBoard, addRound } = await import(resolve(repo, 'src/board.mjs'));
const { renderBoardPage } = await import(resolve(repo, 'src/render.mjs'));

// ── the fake content ─────────────────────────────────────────────────────────
// Scenarios a reviewer would plausibly get: each one exercises a different widget
// and a different context block kind, so the set covers the vocabulary rather than
// showing the same card four times.

const boards = [];

boards.push({
  name: 'SingleChoice',
  theme: 'dark',
  desc: 'One answer, markdown context',
  board: createBoard({
    title: 'Storage migration',
    thread: 'migrate-store',
    blocks: [
      {
        kind: 'markdown',
        text: [
          '## Where we are',
          '',
          'The board store writes one JSON file per board and rewrites it whole on every',
          'submit. That is fine at the current size and starts to hurt somewhere north of',
          'a few thousand boards -- the rewrite is O(board), and two tabs submitting at',
          'once can interleave.',
          '',
          'Three ways out, and they are not equally reversible.',
        ].join('\n'),
      },
      {
        kind: 'question',
        prompt: 'Which migration do you want to commit to?',
        widget: 'single',
        options: [
          {
            label: 'SQLite, one table',
            description:
              'Transactional, handles concurrent submits for free, ships as a single file. Adds a native dep to a repo that currently has none.',
          },
          {
            label: 'Keep JSON, add a write lock',
            description:
              'Smallest change. Fixes the interleave but not the O(board) rewrite. Buys maybe a year.',
          },
          {
            label: 'Append-only log + snapshot',
            description:
              'Fastest writes and a natural audit trail. Most code, and reads need the snapshot to stay correct.',
          },
        ],
      },
    ],
  }),
});

boards.push({
  name: 'MultiChoiceLight',
  theme: 'light',
  desc: 'Several answers, code context, light palette',
  board: createBoard({
    title: 'Release gates',
    thread: 'launch-checks',
    blocks: [
      {
        kind: 'code',
        lang: 'json',
        text: [
          '{',
          '  "scripts": {',
          '    "check": "node test/run.mjs",',
          '    "authorize": "node bin/authorize.mjs"',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        kind: 'question',
        prompt: 'Which of these should block a release, not just warn?',
        widget: 'multi',
        options: [
          { label: 'Full test suite', description: 'test/run.mjs, all 20 checks. Currently ~4 minutes.' },
          { label: 'Contrast audit', description: 'check-contrast.mjs, both palettes against WCAG AA.' },
          { label: 'Token purity', description: 'check-pure.mjs -- fails if a raw hex reaches a CSS rule.' },
          { label: 'Install smoke test', description: 'check-install.mjs. Slowest of the set, and the one that catches real breakage.' },
        ],
      },
    ],
  }),
});

boards.push({
  name: 'RankOrder',
  theme: 'dark',
  desc: 'Drag to order',
  board: createBoard({
    title: 'Launch blockers',
    thread: 'launch-triage',
    blocks: [
      {
        kind: 'markdown',
        text: 'Four things are open. I can get through maybe two before the cut. Order them and I will work down the list.',
      },
      {
        kind: 'question',
        prompt: 'Rank these, most important first.',
        widget: 'rank',
        options: [
          { label: 'Cookie is not scoped to the port', description: 'Two boards on different ports share a credential.' },
          { label: 'Uninstall leaves the daemon plist', description: 'Reinstall then fails silently.' },
          { label: 'Mermaid redraw races a queued render', description: 'Rare, corrupts the diagram when it fires.' },
          { label: 'Index page has no empty state', description: 'A fresh install shows a bare page.' },
        ],
      },
    ],
  }),
});

boards.push({
  name: 'FreeText',
  theme: 'dark',
  desc: 'Open response, side-by-side context',
  board: createBoard({
    title: 'Retry policy',
    thread: 'sse-reconnect',
    blocks: [
      {
        kind: 'compare',
        left: {
          label: 'Today',
          block: {
            kind: 'code',
            lang: 'javascript',
            text: ['let delay = 1000;', '', 'function retry() {', '  setTimeout(connect, delay);', '  delay = delay * 2;', '}'].join('\n'),
          },
        },
        right: {
          label: 'Proposed',
          block: {
            kind: 'code',
            lang: 'javascript',
            text: [
              'let delay = 1000;',
              '',
              'function retry() {',
              '  const jitter = Math.random() * 0.3;',
              '  setTimeout(connect, delay * (1 + jitter));',
              '  delay = Math.min(delay * 2, 30_000);',
              '}',
            ].join('\n'),
          },
        },
      },
      {
        kind: 'question',
        prompt: 'The cap is 30s and the jitter is +/-30%. Anything you would change before I write the test?',
        widget: 'text',
      },
    ],
  }),
});

// A two-round board: round 1 answered and sent (collapsed history styling, disabled
// send bar), round 2 open below it. This is the state a reviewer sees most often and
// the only card that shows both round treatments at once.
{
  const board = createBoard({
    title: 'Theme rollout',
    thread: 'light-palette',
    blocks: [
      {
        kind: 'question',
        prompt: 'Should the light palette be a real design or a mechanical inversion?',
        widget: 'single',
        options: [
          { label: 'Design it against the accent', description: 'Slower, and the only version that will not look muddy.' },
          { label: 'Invert the dark values', description: 'One afternoon. Will need redoing.' },
        ],
      },
    ],
  });
  board.rounds[0].status = 'sent';
  addRound(board, {
    title: 'Follow-up',
    blocks: [
      {
        kind: 'question',
        prompt: 'Light is designed. Which surface should carry the page background?',
        widget: 'single',
        options: [
          { label: '--bg at #eef1f7', description: 'Slightly cool, panels read as raised.' },
          { label: 'Pure white', description: 'Maximum contrast, panels need a border to separate.' },
        ],
      },
    ],
  });
  boards.push({ name: 'SentAndOpen', theme: 'dark', desc: 'A sent round above an open one', board });
}

// ── page -> card ─────────────────────────────────────────────────────────────
// Take the real page, keep its body, rebuild the head. Dropping the client script is
// what makes these static: no hydration, no SSE, no mermaid CDN fetch, no console
// errors in the DS pane. Dropping the inline <style> for a <link> is what makes them
// prove the uploaded styles.css closure actually works.

function toCard({ name, theme, desc, board }) {
  const page = renderBoardPage(board);

  const open = page.indexOf('<body>');
  const cut = page.indexOf('<script id="board-data"');
  if (open < 0 || cut < 0 || cut < open) {
    throw new Error(`${name}: could not find the body span in the rendered page -- src/render.mjs's page shape changed`);
  }
  const body = page.slice(open + '<body>'.length, cut).trim();

  if (body.includes('<script')) throw new Error(`${name}: a script survived the cut`);

  // The board is max-width 1120 and the send bar is pinned to the viewport bottom,
  // so the card needs real height to not look cropped.
  return `<!-- @dsCard group="${GROUP}" viewport="1200x900" -->
<!doctype html>
<html lang="en"${theme === 'light' ? ' data-theme="light"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${desc}</title>
<link rel="stylesheet" href="../../../styles.css">
</head>
<body>
${body}
</body>
</html>
`;
}

// The composition note the design agent reads. Not a component API -- there is no
// component -- but the class recipe for building this surface, which is the thing it
// actually needs from a card.
const PROMPTS = {
  SingleChoice: [
    'A question with one answer and a markdown context block.',
    '',
    'Structure: `.question-block` is a two-column grid -- `.question-main` (prompt +',
    'options) beside `.question-context` (the supporting blocks). The prompt is',
    '`.question-prompt`; each option is a `button.card-choice` wrapping `.opt-main` >',
    '`.opt-label` + `.opt-desc`, with `.opt-check` for the selected mark. Selected state',
    'is the `.selected` class on the button.',
  ].join('\n'),
  MultiChoiceLight: [
    'Multi-select question, rendered in the light palette.',
    '',
    'Same `.card-choice` option markup as single-select; the container carries',
    '`.choice-multi` so the check reads as a checkbox rather than a radio. Light is set',
    'with `data-theme="light"` on `<html>` -- every token has a light value, so nothing',
    'else changes. The context here is a `.code-block`.',
  ].join('\n'),
  RankOrder: [
    'Drag-to-order question.',
    '',
    'The options live in `.rank-list`; each row has `.rank-index` (its position) and',
    '`.rank-grip` (the drag handle). While a row is being dragged it carries',
    '`.dragging`. Rows are ordinary option markup otherwise.',
  ].join('\n'),
  FreeText: [
    'Open-response question with a side-by-side context block.',
    '',
    'The answer control is `.answer-textarea` (min-height 220px, resizes vertically).',
    'The context is `.compare-grid` holding two `.compare-side`s, each labelled with',
    '`.compare-label` -- the idiom for before/after or option-A/option-B.',
  ].join('\n'),
  SentAndOpen: [
    'Two rounds: one already sent, one still open.',
    '',
    'Each round is a `section.round`. A sent round adds `.round-history`, which drops it',
    'to `--history-bg` and removes its shadow so it recedes; the open round keeps',
    '`.round-open`. `.round-label` names each one. The `.send-bar` at the bottom carries',
    'both exits -- `.btn-send` (accent) and `.btn-discuss` (secondary) -- disabled here',
    'because the latest round is sent, with `.send-status` explaining why.',
  ].join('\n'),
};

let n = 0;
for (const spec of boards) {
  const dir = join(OUT, 'components', GROUP, spec.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec.name}.html`), toCard(spec));
  const prompt = PROMPTS[spec.name];
  if (!prompt) throw new Error(`${spec.name}: no PROMPTS entry`);
  writeFileSync(join(dir, `${spec.name}.prompt.md`), prompt + '\n');
  console.log(`  ${spec.name.padEnd(16)} ${spec.theme.padEnd(6)} ${spec.desc}`);
  n++;
}

// package-validate.mjs cross-checks preview count against componentCount and fails on
// a mismatch. The meta file is regenerated by every converter run and never uploaded
// (it is dot-prefixed, so it stays local), so patching it here just makes the local
// bookkeeping match the cards that now exist -- no claim about importable components
// reaches the project.
const metaPath = join(OUT, '.ds-build-meta.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
meta.componentCount = n;
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

// Register the cards in the verification anchor and the stories manifest, using the
// converter's OWN hash function so validate's recompute pass checks these cards on
// every future run -- if a card is hand-edited or a rebuild drops one, [SYNC_STALE]
// catches it instead of the anchor silently vouching for output that no longer exists.
const { renderHashFor } = await import(resolve(repo, '.ds-sync/lib/sync-hashes.mjs'));

const entries = boards.map((s) => ({ name: s.name, group: GROUP }));

const mapPath = join(OUT, '.stories-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
map.components = entries;
writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');

const syncPath = join(OUT, '_ds_sync.json');
const sync = JSON.parse(readFileSync(syncPath, 'utf8'));
for (const c of entries) sync.renderHashes[c.name] = renderHashFor(OUT, c, {});
writeFileSync(syncPath, JSON.stringify(sync, null, 2) + '\n');

// .review.html — the local page a human opens to check every card at once. The
// converter writes one, but it is built before these cards exist, so it lists nothing.
// Dot-prefixed, so it stays local and never uploads.
const review = `<!doctype html>
<html><head><meta charset="utf-8"><title>claude-board — board cards</title>
<style>
  body { margin: 0; padding: 32px; background: #0a0e15; color: #eaeef6;
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, ui-sans-serif, sans-serif; }
  h1 { font-size: 18px; font-weight: 650; margin: 0 0 4px; }
  .sub { color: #8690a2; font-size: 13px; margin-bottom: 28px; }
  section { margin-bottom: 32px; }
  h2 { font-size: 13.5px; font-weight: 600; margin: 0 0 2px; }
  .desc { color: #8690a2; font-size: 12.5px; margin-bottom: 10px; }
  iframe { width: 100%; height: 900px; border: 1px solid rgba(255,255,255,0.14);
           border-radius: 10px; background: #0a0e15; display: block; }
</style></head>
<body>
<h1>claude-board — board cards</h1>
<div class="sub">${boards.length} cards. Invented content, real markup: each one is renderBoardPage() with the client script dropped and the uploaded styles.css linked.</div>
${boards
  .map(
    (s) => `<section>
  <h2>${s.name}</h2>
  <div class="desc">${s.desc} · ${s.theme}</div>
  <iframe src="./components/${GROUP}/${s.name}/${s.name}.html" loading="lazy"></iframe>
</section>`,
  )
  .join('\n')}
</body></html>
`;
writeFileSync(join(OUT, '.review.html'), review);

console.log(`✓ ${n} board cards → ds-bundle/components/${GROUP}/ (anchor + manifest updated, .review.html written)`);
