// The page half of the moving deadline (ADR 145). On a round posted to follow it
// (`movingDeadline` on the round), each answer change, typed answer or note, and saved
// comment reports activity, `POST /api/board/:id/activity { round }`, at most once per
// round every five seconds (the daemon's CLAUDE_BOARD_ACTIVITY_MIN_MS when it is started
// with one) with the last change in a window still reported; a round without the flag, or
// past its deadline, reports nothing, and neither do focus, visibility or scroll. A moved deadline, whether on the report's own answer, the
// `deadline` event or a reconnect's snapshot, is what the countdown reads.
//
// Driven for real: the `ui` script on test/dom-stand-in.mjs, with `fetch` stubbed. The
// route and the event's sender are the daemon's half, test/check-http.mjs's.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';
import { check, finish, flush, pageHarness } from './support.mjs';

const { loadBoardWithEventSource, click, answerSingle, deferBlock } = await pageHarness();

const MINUTE = 60000;
const at = ms => new Date(Date.now() + ms).toISOString();

const BLOCKS = [
  { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  { kind: 'question', prompt: 'Which ones?', widget: 'multi', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
  { kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'One' }, { label: 'Two' }] },
  { kind: 'question', prompt: 'Anything else?', widget: 'text' },
  {
    kind: 'question', prompt: 'Which card?', widget: 'choose-between-rendered-variants',
    options: [{ label: 'Card A', block: { kind: 'markdown', text: 'Card A' } }, { label: 'Card B', block: { kind: 'markdown', text: 'Card B' } }],
  },
  { kind: 'mermaid', text: 'flowchart TD\n  a --> b' },
];

/** Round 1 of a board asking every widget, awaited (it asks), its deadline `deadlineIn`
 * from now, and posted to follow the moving deadline unless `moving` is false. */
function boardWith({ moving = true, deadlineIn = 30 * MINUTE } = {}) {
  const board = createBoard({ title: 'Moving deadline', blocks: BLOCKS });
  board.rounds[0].awaitDeadline = at(deadlineIn);
  if (moving) board.rounds[0].movingDeadline = true;
  return board;
}

/** Stubs `fetch`: every call recorded as `{ url, method, body }`, each answered by
 * `respond(call)` (default a 200 whose body moves nothing). Restore in a finally. */
function stubFetch(respond = () => ({ ok: true, status: 200, json: async () => ({ round: 1, awaitDeadline: null, moved: false }) })) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, opts) => {
    const call = { url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    return Promise.resolve().then(() => respond(call));
  };
  return { calls, activity: () => calls.filter(c => /\/activity$/.test(c.url)), restore: () => { globalThis.fetch = original; } };
}

/** Holds every `setTimeout` the page books past a second (the activity window; the
 * stand-in's own short timers still run), so a check runs the booked report itself. */
function holdTimers() {
  const original = globalThis.setTimeout;
  const held = [];
  globalThis.setTimeout = (fn, delay, ...rest) => {
    if (delay > 1000) { held.push({ fn, delay }); return held.length; }
    return original(fn, delay, ...rest);
  };
  return { held, restore: () => { globalThis.setTimeout = original; } };
}

/** The question asking `widget`, or the diagram for 'mermaid'. */
const blockOf = (document, widget) => document.querySelector(widget === 'mermaid' ? '.mermaid-block' : `.question-block[data-widget="${widget}"]`);

function typeInto(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new StandInEvent('input'));
}

const GESTURES = {
  'a pick': document => answerSingle(blockOf(document, 'single'), 'Yes'),
  'a multi-select toggle': document => click(blockOf(document, 'multi').querySelector('.choice-multi')),
  'a rank move': document => {
    const list = blockOf(document, 'rank').querySelector('.rank-list');
    list.querySelector('li').dispatchEvent(new StandInEvent('dragstart'));
    list.dispatchEvent(new StandInEvent('dragend'));
  },
  'a rendered-variant pick': document => click(blockOf(document, 'choose-between-rendered-variants').querySelector('.choice-variant')),
  'a Defer': document => deferBlock(blockOf(document, 'single')),
  'a typed answer': document => typeInto(blockOf(document, 'text').querySelector('textarea[data-answer-for]'), 'Ship Friday'),
  'a typed note': document => typeInto(blockOf(document, 'single').querySelector('textarea[data-note-for]'), 'Only after the review'),
  'a saved comment': document => {
    const diagram = blockOf(document, 'mermaid');
    click(diagram.querySelector('.comment-btn'));
    const form = document.getElementById(`comment-form-${diagram.getAttribute('data-block-id')}`);
    form.querySelector('input[type=text]').value = 'The arrow points the wrong way';
    form.dispatchEvent(new StandInEvent('submit'));
  },
};

const countdown = document => document.querySelector('span#round-countdown').textContent;
const meta = document => document.querySelector('span#round-meta').textContent;

for (const [name, gesture] of Object.entries(GESTURES)) {
  await check(`${name} on a round following the moving deadline sends one activity report naming its round`, async () => {
    const board = boardWith();
    const { document } = loadBoardWithEventSource(renderBoardPage(board));
    const { activity, restore } = stubFetch();
    try {
      gesture(document);
      await flush(1);
      assert.deepEqual(activity(), [{ url: `/api/board/${board.id}/activity`, method: 'POST', body: { round: 1 } }]);
    } finally { restore(); }
  });
}

await check('a round posted without the moving deadline, or past its deadline, sends no activity report for any of those', async () => {
  const fixtures = { 'without movingDeadline': boardWith({ moving: false }), 'past its deadline': boardWith({ deadlineIn: -MINUTE }) };
  for (const [fixture, board] of Object.entries(fixtures)) {
    for (const [name, gesture] of Object.entries(GESTURES)) {
      const { document } = loadBoardWithEventSource(renderBoardPage(board));
      const { activity, restore } = stubFetch();
      try {
        gesture(document);
        await flush(1);
        assert.deepEqual(activity(), [], `${name}, on a round ${fixture}`);
      } finally { restore(); }
    }
  }
});

await check('focus, blur, a visibility change and a scroll send no activity report: a tab left open is not the reviewer working', async () => {
  const { document, window } = loadBoardWithEventSource(renderBoardPage(boardWith()));
  const { activity, restore } = stubFetch();
  try {
    window.dispatchEvent(new StandInEvent('blur'));
    window.dispatchEvent(new StandInEvent('focus'));
    document.dispatchEvent(new StandInEvent('visibilitychange'));
    window.dispatchEvent(new StandInEvent('scroll'));
    await flush(1);
    assert.deepEqual(activity(), []);
  } finally { restore(); }
});

/** The page's script as a daemon started with `CLAUDE_BOARD_ACTIVITY_MIN_MS=<value>` serves
 * it: src/ui.mjs evaluated afresh under that environment. */
async function uiUnderActivityMin(value) {
  const previous = process.env.CLAUDE_BOARD_ACTIVITY_MIN_MS;
  process.env.CLAUDE_BOARD_ACTIVITY_MIN_MS = value;
  try {
    return (await import(`../src/ui.mjs?activity-min=${value}`)).ui;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BOARD_ACTIVITY_MIN_MS;
    else process.env.CLAUDE_BOARD_ACTIVITY_MIN_MS = previous;
  }
}

for (const { gap, minMs, script } of [
  { gap: 'the route\'s five seconds', minMs: 5000, script: undefined },
  { gap: 'a daemon\'s CLAUDE_BOARD_ACTIVITY_MIN_MS of 30 s', minMs: 30000, script: await uiUnderActivityMin('30000') },
]) {
  await check(`a note typed in bursts reports at once, then once at the end of each window of ${gap}, carrying the last change`, async () => {
    const board = boardWith();
    const { document } = loadBoardWithEventSource(renderBoardPage(board), script ? { script } : {});
    const note = blockOf(document, 'single').querySelector('textarea[data-note-for]');
    const { activity, restore } = stubFetch();
    const timers = holdTimers();
    try {
      typeInto(note, 'O');
      typeInto(note, 'On');
      typeInto(note, 'Onl');
      assert.equal(activity().length, 1, 'the first keystroke reports at once, the rest of the burst waits');
      assert.equal(timers.held.length, 1, 'one report booked for the end of the window, however many keys');
      assert.ok(timers.held[0].delay > minMs && timers.held[0].delay <= minMs + 250,
        `booked past the route's ${minMs}ms, so the daemon takes it: ${timers.held[0].delay}ms`);
      timers.held[0].fn();
      assert.equal(activity().length, 2, 'the booked report goes at the end of the window');
      typeInto(note, 'Only');
      assert.equal(activity().length, 2, 'a keystroke right after it waits for the next window');
      assert.equal(timers.held.length, 2, 'and books that window\'s one report');
      assert.ok(activity().every(c => c.body.round === 1));
    } finally { timers.restore(); restore(); }
  });
}

for (const [failure, respond] of Object.entries({
  'refused inside the window (429)': () => ({ ok: false, status: 429, json: async () => ({ retryAfterMs: 3000 }) }),
  'lost to the network': () => Promise.reject(new Error('network down')),
})) {
  await check(`a report ${failure} is dropped quietly, and the next change reports again`, async () => {
    const board = boardWith({ deadlineIn: 10 * MINUTE });
    const { document } = loadBoardWithEventSource(renderBoardPage(board));
    const { activity, restore } = stubFetch(respond);
    const timers = holdTimers();
    try {
      answerSingle(blockOf(document, 'single'), 'Yes');
      await flush(1);
      assert.equal(activity().length, 1);
      assert.equal(timers.held.length, 0, 'nothing retries the dropped report');
      assert.equal(countdown(document), '10m left', 'the countdown keeps the deadline it had');
      answerSingle(blockOf(document, 'single'), 'No');
      assert.equal(timers.held.length, 1, 'the next change books its report');
      timers.held[0].fn();
      assert.equal(activity().length, 2);
    } finally { timers.restore(); restore(); }
  });
}

await check('the report\'s answer moves the countdown and the header pill to the new deadline', async () => {
  const board = boardWith({ deadlineIn: 10 * MINUTE });
  const { document } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(countdown(document), '10m left', 'setup: ten minutes left before the pick');
  const moved = at(40 * MINUTE);
  const { restore } = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ round: 1, awaitDeadline: moved, moved: true }) }));
  try {
    answerSingle(blockOf(document, 'single'), 'Yes');
    await flush(1);
    assert.equal(countdown(document), '40m left');
    assert.equal(meta(document), '40m left');
  } finally { restore(); }
});

await check('a deadline event moves the countdown, and an earlier deadline arriving after it does not move it back', () => {
  const board = boardWith({ deadlineIn: 10 * MINUTE });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(countdown(document), '10m left', 'setup: ten minutes left');
  es.dispatch('deadline', JSON.stringify({ round: 1, awaitDeadline: at(40 * MINUTE) }));
  assert.equal(countdown(document), '40m left');
  assert.equal(meta(document), '40m left');
  es.dispatch('deadline', JSON.stringify({ round: 1, awaitDeadline: at(20 * MINUTE) }));
  assert.equal(countdown(document), '40m left', 'an overtaken deadline changes nothing');
});

await check('a tab whose stream dropped while the deadline moved takes the new deadline off its reconnect snapshot', async () => {
  const board = boardWith({ deadlineIn: 10 * MINUTE });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(countdown(document), '10m left', 'setup: ten minutes left');
  const later = structuredClone(board);
  later.rounds[0].awaitDeadline = at(40 * MINUTE);
  const freshPage = renderBoardPage(later);
  const { restore } = stubFetch(() => ({ ok: true, status: 200, text: async () => freshPage }));
  const originalParser = globalThis.DOMParser;
  globalThis.DOMParser = class { parseFromString(text) { return parseHTML(text); } };
  try {
    es.dispatch('open', '');
    await flush(1);
    assert.equal(countdown(document), '40m left');
  } finally {
    globalThis.DOMParser = originalParser;
    restore();
  }
});

await finish('activity-client');
