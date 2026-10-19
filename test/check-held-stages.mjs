// A push sends a stage the tab already holds empty and held (ADR 122), and the page
// fills a held frame no live frame could stand for from the daemon. This file drives
// that path end to end: a real daemon in-process, the real page script in the DOM
// stand-in, each read the page makes routed to the daemon and recorded, and each push
// the daemon broadcasts handed to the page's stream (or held back, for a tab whose
// stream was down). What it holds:
//
//   - the page reads once for what a catch-up brought in, and later calls join that read;
//   - a read that failed is tried again on the next catch-up, whichever path it takes;
//   - a stage goes only into a frame that names its sha;
//   - a call that joins a running fill has it read again each stage it asked for that is
//     still held: one a push held again where no live frame stands in, one whose read failed;
//   - an amend holds only the stages a block already held in the open round;
//   - a tab running a page script from before ADR 122 gets every stage whole, and its
//     catch-up sees no stage change;
//   - Pull-out on a held frame starts a fill and says why nothing opened, on the control and
//     in a note beside it, until the frame is filled by that fill or any later one, a round
//     push that keeps the frame keeping both;
//   - a fill reads the stages it fills, not every stage on the board.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';
import { computeBoardPatch } from '../src/patch.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML, resolveComputedProperty } from './dom-stand-in.mjs';
import {
  boardDataOf, check, openSseClient, pageHarness, postBoard, rawRequest, renderedMarkup, runMain,
  secretFetch, secretHome, waitFor, writeHeaders,
} from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-held-stages-', { secret: 'd'.repeat(64) });
const realFetch = globalThis.fetch;
const realParser = globalThis.DOMParser;
const daemonFetch = secretFetch(SECRET, realFetch);

let server, port, base;
const streams = [];

/** Routes the page's reads to the daemon while `fn` runs, and answers what `fn` does.
 * `fn` gets `{ reads, settle }`: `reads`, each URL the page asked for under `/b/`, in
 * order; `settle()`, which resolves once no read is out and the page has done what each
 * answer set off. `gate(url)` may answer 'fail' (the read fails as a dropped network
 * does) or a promise the answer waits on, after the daemon has rendered it, as a slow
 * download of an answer already sent. */
async function withPageReads(fn, { gate = () => null } = {}) {
  const reads = [];
  let out = 0;
  globalThis.DOMParser = class { parseFromString(text) { return parseHTML(text); } };
  globalThis.fetch = async (url, opts) => {
    const page = String(url).startsWith('/b/');
    if (page) reads.push(String(url));
    const held = page ? gate(String(url)) : null;
    if (held === 'fail') throw new TypeError('network connection lost');
    out++;
    try {
      const r = await daemonFetch(`${base}${url}`, opts);
      const text = await r.text();
      if (held) await held;
      return { ok: r.ok, status: r.status, text: async () => text, json: async () => JSON.parse(text) };
    } finally {
      out--;
    }
  };
  const settle = async () => {
    const deadline = Date.now() + 5000;
    for (let quiet = 0; quiet < 5;) {
      assert.ok(Date.now() < deadline, 'setup failure: the page\'s reads never settled');
      await new Promise(resolve => setTimeout(resolve, 5));
      quiet = out ? 0 : quiet + 1;
    }
  };
  try {
    return await fn({ reads, settle });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.DOMParser = realParser;
  }
}

/** A `gate` for withPageReads that holds each fill read, by its place among them, until
 * `release(n)` lets the n-th through or `fail(n)` fails it as a dropped download does;
 * either may come before that read goes out. */
function fillGates() {
  const held = [];
  let next = 0;
  const at = n => {
    if (!held[n]) {
      const hold = {};
      hold.promise = new Promise((resolve, reject) => { hold.resolve = resolve; hold.reject = reject; });
      hold.promise.catch(() => {}); // failed before the read awaits it: not unhandled
      held[n] = hold;
    }
    return held[n];
  };
  return {
    gate: url => (fills([url]).length ? at(next++).promise : null),
    release: n => at(n).resolve(),
    fail: n => at(n).reject(new TypeError('network connection lost')),
  };
}

/** A board's stream as a page opens it, `?stages=held` or not (`query`), collecting what
 * the daemon broadcasts. */
async function openStream(boardId, query) {
  const sse = await openSseClient(port, boardId, { secret: SECRET, comments: false, query });
  sse.cursor = 0;
  streams.push(sse);
  await waitFor(() => sse.events.some(e => e.event === 'watcher'), { what: 'the stream\'s watcher event' });
  return sse;
}

/** The next `name` event `sse` collects from now on. */
async function nextEvent(sse, name) {
  const from = sse.events.length;
  return waitFor(() => sse.events.slice(from).find(e => e.event === name), { what: `a ${name} event` });
}

/** Hands the page's stream every push `sse` collected since the last call, in order. */
function deliver(sse, es) {
  for (; sse.cursor < sse.events.length; sse.cursor++) {
    const ev = sse.events[sse.cursor];
    if (ev.event === 'round' || ev.event === 'submitted') es.dispatch(ev.event, JSON.stringify(ev.data));
  }
}

/** Drops what `sse` collected so far: the pushes a tab whose stream was down never got. */
function miss(sse) { sse.cursor = sse.events.length; }

/** The page as served, loaded in the stand-in with the real page script. */
async function openTab(boardId) {
  const { loadBoardWithEventSource } = await pageHarness();
  const page = await (await daemonFetch(`${base}/b/${boardId}`)).text();
  return loadBoardWithEventSource(page);
}

const post = body => postBoard(port, SECRET, body);
const submit = async (boardId, round, answers) => {
  const r = await daemonFetch(`${base}/api/board/${boardId}/submit`, {
    method: 'POST', headers: writeHeaders(SECRET), body: JSON.stringify({ round, action: 'send', answers, comments: [] }),
  });
  assert.equal(r.status, 200, `setup failure: the Send answered ${r.status}`);
};
const yesNo = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'yes' }, { label: 'no' }] });
const stage = html => ({ kind: 'html', html });
const stored = boardId => readBoard(boardId, home);
/** The frame of top-level block `id` on the page. */
const frameOf = (document, id) => document.querySelector(`section.html-block[data-block-id="${id}"] iframe.html-stage`);
/** The reads that fill frames, not the catch-ups. */
const fills = reads => reads.filter(u => /\?stages=/.test(u) && !u.endsWith('?stages=held'));
/** The note beside the Pull-out in `frame`'s corner, or null. */
const pullOutNote = frame => frame.closest('.stage-wrap').querySelector('.pull-out-note');
/** The shas a fill read names. */
const named = url => decodeURIComponent(url.slice(url.indexOf('?stages=') + '?stages='.length)).split(',');

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  await check('a reconnect after several missed rounds reads the page once for every stage the catch-up brought in, and a push landing while that read is out joins it', async () => {
    const { boardId } = await post({ title: 'Missed rounds', blocks: [{ kind: 'markdown', text: 'Round one' }, stage('<p>ROUND-ONE</p>')] });
    const { document, es } = await openTab(boardId);
    const sse = await openStream(boardId, '?stages=held');
    // Three rounds land while this tab's stream is down.
    await post({ boardId, title: 'Missed rounds', blocks: [{ kind: 'markdown', text: 'Round two' }, stage('<p>ROUND-TWO</p>')] });
    await post({ boardId, title: 'Missed rounds', blocks: [{ kind: 'markdown', text: 'Round three' }, stage('<p>ROUND-THREE</p>')] });
    await post({ boardId, title: 'Missed rounds', blocks: [yesNo('Ship it?'), stage('<p>ROUND-FOUR</p>')] });
    await waitFor(() => sse.events.filter(e => e.event === 'round').length === 3, { what: 'the three round pushes' });
    miss(sse);
    const board = stored(boardId);
    const missed = board.blocks.filter(b => b.kind === 'html' && b.round > 1);
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    await withPageReads(async ({ reads, settle }) => {
      es.dispatch('open', '');
      await waitFor(() => fills(reads).length > 0, { what: 'the fill read' });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(fills(reads).length, 1, `the reconnect sends one fill read, not one per missed round: ${JSON.stringify(reads)}`);
      // A Send from another tab while the fill is still downloading: its push holds
      // the round's stage, which this tab's held frame is waiting on.
      const sent = nextEvent(sse, 'submitted');
      await submit(boardId, 4, [{ id: board.blocks.find(b => b.kind === 'question').id, choice: 'yes' }]);
      await sent;
      deliver(sse, es);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(fills(reads).length, 1, 'the Send\'s push joins the read that is out rather than sending another');
      release();
      await settle();
      assert.deepEqual(reads.filter(u => !fills(reads).includes(u)), [`/b/${boardId}?stages=held`], 'the one catch-up, with every stage held');
      assert.equal(fills(reads).length, 1, 'and none after it, since it asked for every frame left held');
      assert.deepEqual(named(fills(reads)[0]).sort(), missed.map(b => b.sha).sort(), 'naming each stage the missed rounds brought in');
    }, { gate: url => (fills([url]).length ? slow : null) });
    for (const b of missed) {
      const frame = frameOf(document, b.id);
      assert.ok(frame, `setup failure: round ${b.round}'s stage never reached the page`);
      assert.equal(frame.hasAttribute('data-held'), false, `round ${b.round}'s frame is filled`);
      assert.ok(frame.getAttribute('srcdoc').includes(b.html), `with round ${b.round}'s own stage`);
    }
    assert.equal(document.querySelector('.round[data-round="4"]').classList.contains('round-history'), true, 'setup failure: the Send\'s push did not land');
  });

  await check('a fill that failed is tried again on the next catch-up: on its early return, where nothing changed, and on its status-only path, where only a Send landed', async () => {
    const { boardId } = await post({ title: 'A fill that failed', blocks: [yesNo('Right?'), stage('<p>STAGE-ZERO</p>')] });
    const stageId = stored(boardId).blocks[1].id;
    const { document, es } = await openTab(boardId);
    const amendStage = async html => {
      await post({ boardId, title: 'A fill that failed', blocks: [{ id: stageId, kind: 'html', html }] });
      return stored(boardId).blocks.find(b => b.id === stageId).sha;
    };
    let failing = true;
    await withPageReads(async ({ reads, settle }) => {
      const reconnect = async () => { es.dispatch('open', ''); await settle(); };
      const one = await amendStage('<p>STAGE-ONE</p>');
      await reconnect();
      assert.deepEqual(fills(reads), [`/b/${boardId}?stages=${one}`], 'setup failure: the amend\'s catch-up never sent its fill');
      assert.equal(frameOf(document, stageId).hasAttribute('data-held'), true, 'setup failure: the failed fill filled the frame');
      failing = false;
      await reconnect();
      assert.equal(reads.at(-2), `/b/${boardId}?stages=held`, 'setup failure: the second reconnect read no catch-up');
      assert.deepEqual(fills(reads), [`/b/${boardId}?stages=${one}`, `/b/${boardId}?stages=${one}`], 'a catch-up that finds nothing changed tries the fill again');
      assert.equal(frameOf(document, stageId).hasAttribute('data-held'), false, 'and fills the frame');
      assert.match(frameOf(document, stageId).getAttribute('srcdoc'), /STAGE-ONE/, 'with the stage the board holds');

      failing = true;
      const two = await amendStage('<p>STAGE-TWO</p>');
      await reconnect();
      assert.equal(frameOf(document, stageId).getAttribute('data-sha'), two, 'setup failure: the second amend\'s catch-up did not land');
      assert.equal(frameOf(document, stageId).hasAttribute('data-held'), true, 'setup failure: the failed fill filled the frame');
      await submit(boardId, 1, [{ id: stored(boardId).blocks[0].id, choice: 'yes' }]);
      failing = false;
      await reconnect();
      assert.equal(document.querySelector('.round[data-round="1"]').classList.contains('round-history'), true, 'setup failure: the catch-up did not take the Send in');
      assert.equal(fills(reads).at(-1), `/b/${boardId}?stages=${two}`, 'a catch-up that finds only a Send tries the fill again');
      assert.equal(frameOf(document, stageId).hasAttribute('data-held'), false, 'and fills the frame');
      assert.match(frameOf(document, stageId).getAttribute('srcdoc'), /STAGE-TWO/, 'with the stage the board holds');
    }, { gate: url => (failing && fills([url]).length ? 'fail' : null) });
  });

  await check('a fill answering late never writes its stage into a frame a later catch-up has made over under another sha: that frame gets its own stage', async () => {
    const { boardId } = await post({ title: 'A late fill', blocks: [yesNo('Right?'), stage('<p>STAGE-ZERO</p>')] });
    const stageId = stored(boardId).blocks[1].id;
    const { document, es } = await openTab(boardId);
    const amendStage = html => post({ boardId, title: 'A late fill', blocks: [{ id: stageId, kind: 'html', html }] });
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    let first = true;
    await withPageReads(async ({ reads, settle }) => {
      await amendStage('<p>STAGE-ONE</p>');
      es.dispatch('open', '');
      await waitFor(() => fills(reads).length === 1, { what: 'the first fill read' });
      // The stream drops again while that read is out, the stage changes again, and the
      // catch-up on the next reconnect makes the frame over, held, under the new sha.
      await amendStage('<p>STAGE-TWO</p>');
      const two = stored(boardId).blocks.find(b => b.id === stageId).sha;
      es.dispatch('open', '');
      await waitFor(() => frameOf(document, stageId).getAttribute('data-sha') === two, { what: 'the second catch-up' });
      release();
      await settle();
      const frame = frameOf(document, stageId);
      assert.equal(frame.getAttribute('data-sha'), two, 'the frame still names the stage the board holds');
      assert.doesNotMatch(frame.getAttribute('srcdoc') || '', /STAGE-ONE/, 'the late answer\'s stage never went into it');
      assert.match(frame.getAttribute('srcdoc') || '', /STAGE-TWO/, 'the frame is filled with its own stage, read once the late answer settled');
      assert.equal(named(fills(reads).at(-1)).join(), two, 'by a read of that stage alone');
    }, { gate: url => (fills([url]).length && first ? (first = false, slow) : null) });
  });

  await check('a stage a push holds again while the fill reads another, in a new place no live frame can stand in, is read once that read returns, not left empty', async () => {
    const title = 'Held again';
    const { boardId } = await post({
      title,
      blocks: [{ ...yesNo('Which?'), context: [stage('<p>S-ZERO</p>'), stage('<p>X-STAGE</p>')] }, stage('<p>T-ZERO</p>')],
    });
    const [question, top] = stored(boardId).blocks;
    const { document, es } = await openTab(boardId);
    const sse = await openStream(boardId, '?stages=held');
    const amend = async block => {
      const pushed = nextEvent(sse, 'round');
      await post({ boardId, title, blocks: [block] });
      await pushed;
    };
    const askWith = (...context) => amend({ id: question.id, ...yesNo('Which?'), context: context.map(stage) });
    const frameNamed = sha => document.querySelector(`iframe.html-stage[data-sha="${sha}"]`);
    const { gate, release } = fillGates();
    await withPageReads(async ({ reads, settle }) => {
      // The stream is down while a stage in the question's context changes: the
      // catch-up brings it in held, and the fill's first read asks for it.
      await askWith('<p>S-ONE</p>', '<p>X-STAGE</p>');
      miss(sse);
      const s = stored(boardId).blocks[0].context[0].sha;
      es.dispatch('open', '');
      await waitFor(() => fills(reads).length === 1, { what: 'the first fill read' });
      assert.deepEqual(named(fills(reads)[0]), [s], 'setup failure: the first read is not of the changed context stage alone');
      // Down again while that read is out, and the top-level stage changes: its
      // catch-up joins the fill, which reads that stage next.
      await amend({ id: top.id, kind: 'html', html: '<p>T-ONE</p>' });
      miss(sse);
      const t = stored(boardId).blocks[1].sha;
      es.dispatch('open', '');
      await waitFor(() => frameOf(document, top.id).getAttribute('data-sha') === t, { what: 'the second catch-up' });
      release(0);
      await waitFor(() => fills(reads).length === 2, { what: 'the second fill read' });
      assert.deepEqual(named(fills(reads)[1]), [t], 'setup failure: the second read is not of the top-level stage alone');
      assert.match(frameNamed(s).getAttribute('srcdoc') || '', /S-ONE/, 'setup failure: the first read did not fill the context stage');
      // While the second read is out, a live amend swaps the context's two stages. The
      // block held both, so the push holds both, and no live frame stands for one in a
      // new order (keptStages): the context stage the fill already filled is held again.
      await askWith('<p>X-STAGE</p>', '<p>S-ONE</p>');
      deliver(sse, es);
      assert.equal(frameNamed(s).hasAttribute('data-held'), true, 'setup failure: a live frame still stands for the context stage');
      release(1);
      release(2);
      await settle();
      const frame = frameNamed(s);
      assert.equal(frame.hasAttribute('data-held'), false, 'the context stage held again is filled');
      assert.match(frame.getAttribute('srcdoc'), /S-ONE/, 'with its stage');
      assert.ok(fills(reads).slice(2).some(u => named(u).includes(s)), `by a read after the one that was out: ${JSON.stringify(fills(reads))}`);
    }, { gate });
  });

  await check('a stage whose read fails after a later call joined the fill is read again by the fill\'s next read, not left empty until a reconnect', async () => {
    const title = 'Failed, then read again';
    const { boardId } = await post({ title, blocks: [yesNo('Right?'), stage('<p>A-ZERO</p>'), stage('<p>B-ZERO</p>')] });
    const [, first, second] = stored(boardId).blocks;
    const { document, es } = await openTab(boardId);
    const amendStage = async (id, html) => {
      await post({ boardId, title, blocks: [{ id, kind: 'html', html }] });
      return stored(boardId).blocks.find(b => b.id === id).sha;
    };
    const { gate, release, fail } = fillGates();
    await withPageReads(async ({ reads, settle }) => {
      const a = await amendStage(first.id, '<p>A-ONE</p>');
      es.dispatch('open', '');
      await waitFor(() => fills(reads).length === 1, { what: 'the first fill read' });
      // A second catch-up, while the first read is still downloading, brings in a
      // second stage held and joins the fill.
      const b = await amendStage(second.id, '<p>B-ONE</p>');
      es.dispatch('open', '');
      await waitFor(() => frameOf(document, second.id).getAttribute('data-sha') === b, { what: 'the second catch-up' });
      fail(0);
      release(1);
      release(2);
      await settle();
      assert.deepEqual(named(fills(reads)[0]), [a], 'setup failure: the first read is not of the first stage alone');
      for (const [id, text] of [[first.id, /A-ONE/], [second.id, /B-ONE/]]) {
        assert.equal(frameOf(document, id).hasAttribute('data-held'), false, `the frame of ${text.source} is filled`);
        assert.match(frameOf(document, id).getAttribute('srcdoc'), text, 'with its stage');
      }
      assert.ok(fills(reads).slice(1).some(u => named(u).includes(a)), `the failed stage by a read after the one that failed: ${JSON.stringify(fills(reads))}`);
    }, { gate });
  });

  await check('an amend holds only the stages a block it re-posts already held in the open round: a block it adds goes out whole, though its stage matches one an earlier round showed', async () => {
    const { boardId } = await post({ title: 'Amend holds', blocks: [{ kind: 'markdown', text: 'Earlier' }, stage('<p>SHOWN-EARLIER</p>')] });
    await post({ boardId, title: 'Amend holds', blocks: [yesNo('Which?'), stage('<p>KEPT</p>')] });
    const before = stored(boardId);
    const kept = before.blocks.find(b => b.round === 2 && b.kind === 'html');
    const sse = await openStream(boardId, '?stages=held');
    const pushed = nextEvent(sse, 'round');
    await post({ boardId, title: 'Amend holds', blocks: [{ id: kept.id, kind: 'html', html: '<p>KEPT</p>' }, stage('<p>SHOWN-EARLIER</p>')] });
    const { data } = await pushed;
    assert.equal(data.mode, 'amend', 'setup failure: the post did not amend the open round');
    const added = stored(boardId).blocks.find(b => b.round === 2 && b.kind === 'html' && b.id !== kept.id);
    assert.equal(added.sha, before.blocks[1].sha, 'setup failure: the added stage is not the one round 1 showed');
    const frag = parseHTML(`<div>${data.html}</div>`);
    const frame = id => frag.querySelector(`section.html-block[data-block-id="${id}"] iframe.html-stage`);
    assert.equal(frame(kept.id).hasAttribute('data-held'), true, 'the re-posted block\'s unchanged stage goes out held');
    assert.equal(frame(added.id).hasAttribute('data-held'), false, 'the added block\'s stage does not, since no tab holds a frame in a block it never had');
    assert.match(frame(added.id).getAttribute('srcdoc'), /SHOWN-EARLIER/, 'it goes out whole');
  });

  await check('a tab running the page script from before held frames, whose stream declares nothing, never receives a held stage: its amend and Send pushes carry every stage whole, with the html on its board', async () => {
    const { boardId } = await post({ title: 'Old script', blocks: [yesNo('Right?'), stage('<p>OLD-SCRIPT-STAGE</p>')] });
    const { es } = await openTab(boardId);
    assert.equal(es.url, `/api/board/${boardId}/events?stages=held`, 'today\'s page script declares on its stream that it fills held frames');
    const fresh = await openStream(boardId, '?stages=held');
    const old = await openStream(boardId, '');
    const [stageBlock] = stored(boardId).blocks.filter(b => b.kind === 'html');
    const amended = nextEvent(old, 'round');
    const amendedFresh = nextEvent(fresh, 'round');
    await post({ boardId, title: 'Old script', blocks: [{ id: stageBlock.id, kind: 'html', html: '<p>OLD-SCRIPT-STAGE</p>' }] });
    const sent = nextEvent(old, 'submitted');
    const sentFresh = nextEvent(fresh, 'submitted');
    await submit(boardId, 1, [{ id: stored(boardId).blocks[0].id, choice: 'yes' }]);
    assert.match((await amendedFresh).data.html, /data-held/, 'setup failure: a declaring stream\'s amend push holds nothing');
    assert.match((await sentFresh).data.html, /data-held/, 'setup failure: a declaring stream\'s Send push holds nothing');
    for (const [what, { data }] of [['amend', await amended], ['Send', await sent]]) {
      assert.doesNotMatch(data.html, /data-held/, `the ${what} push holds no stage`);
      assert.match(data.html, /srcdoc="[^"]*OLD-SCRIPT-STAGE/, `its frame carries the stage whole`);
      const block = data.board.blocks.find(b => b.id === stageBlock.id);
      assert.equal(block.html, '<p>OLD-SCRIPT-STAGE</p>', `and its board keeps the stage's html, the copy that script diffs against`);
    }
  });

  await check('an old page script\'s catch-up, a fetch of the plain page, sees no stage change against the copy it holds, while the page as navigated still carries each stage once', async () => {
    const { boardId } = await post({
      title: 'Old catch-up',
      blocks: [{ ...yesNo('Right?'), context: [stage('<p>CONTEXT-STAGE</p>')] }, stage('<p>TOP-STAGE</p>')],
    });
    // The copy a page script from before ADR 122 holds: every block as stored, html
    // included (that script's page inlined the stored blocks whole).
    const held = stored(boardId);
    await submit(boardId, 1, [{ id: held.blocks[0].id, choice: 'yes' }]);
    const read = dest => rawRequest(port, 'GET', `/b/${boardId}`, { headers: { [SECRET_HEADER]: SECRET, 'sec-fetch-dest': dest } });
    const catchUp = await read('empty');
    assert.equal(catchUp.status, 200);
    const patch = computeBoardPatch({ blocks: held.blocks, rounds: held.rounds }, JSON.parse(boardDataOf(catchUp.body)));
    assert.deepEqual(patch.roundsNowSent, [1], 'setup failure: the catch-up did not see the Send');
    assert.deepEqual([...patch.addedBlockIds, ...patch.changedBlockIds], [], 'no block reads as changed, so the old script replaces no stage');
    const navigated = await read('document');
    const inlined = boardDataOf(navigated.body);
    assert.ok(!inlined.includes('TOP-STAGE') && !inlined.includes('CONTEXT-STAGE'), 'the page a navigation gets carries no stage html in #board-data');
    assert.equal(renderedMarkup(navigated.body).split('TOP-STAGE').length - 1, 1, 'and carries the stage once, in its frame');
  });

  await check('Pull-out on a held frame not yet filled starts a fill and says why nothing opened, on the control and in a note beside it, then that the stage did not load, and a second press fills it and takes the note away', async () => {
    const { boardId } = await post({ title: 'Pull-out on a held frame', blocks: [yesNo('Right?'), stage('<p>STAGE-ZERO</p>')] });
    const stageId = stored(boardId).blocks[1].id;
    const { document, es } = await openTab(boardId);
    const { click } = await pageHarness();
    let failing = true;
    await withPageReads(async ({ reads, settle }) => {
      await post({ boardId, title: 'Pull-out on a held frame', blocks: [{ id: stageId, kind: 'html', html: '<p>STAGE-ONE</p>' }] });
      const one = stored(boardId).blocks[1].sha;
      es.dispatch('open', '');
      await settle();
      const frame = frameOf(document, stageId);
      assert.equal(frame.hasAttribute('data-held'), true, 'setup failure: the frame is not held');
      const control = frame.closest('.html-block').querySelector('.pull-out');
      const label = control.getAttribute('title');
      assert.equal(pullOutNote(frame), null, 'setup failure: a note shows before any press');
      const fillsBefore = fills(reads).length;
      click(control);
      assert.equal(document.querySelector('.stage-lens-frame'), null, 'nothing opens');
      assert.match(control.getAttribute('title'), /still loading/, 'the control says the stage is still loading');
      assert.equal(control.getAttribute('aria-label'), control.getAttribute('title'), 'to a screen reader too');
      const note = pullOutNote(frame);
      assert.ok(note, 'and a note beside the control says it on screen');
      assert.equal(note.textContent, control.getAttribute('title'), 'in the control\'s own words');
      assert.notEqual(resolveComputedProperty(styles, note, false, 'display'), 'none', 'a note the stylesheet shows');
      assert.equal(note.getAttribute('aria-hidden'), 'true', 'and a screen reader skips, since the control\'s label already says it');
      await settle();
      assert.deepEqual(fills(reads).slice(fillsBefore), [`/b/${boardId}?stages=${one}`], 'the press started a fill of that stage');
      assert.match(control.getAttribute('title'), /did not load/, 'and, once it failed, the control says the stage did not load');
      assert.equal(pullOutNote(frame) && pullOutNote(frame).textContent, control.getAttribute('title'), 'and so does the note');
      failing = false;
      click(control);
      await settle();
      assert.equal(frame.hasAttribute('data-held'), false, 'a second press fills the frame');
      assert.match(frame.getAttribute('srcdoc'), /STAGE-ONE/, 'with its stage');
      assert.equal(control.getAttribute('title'), label, 'and the control says again what it does');
      assert.equal(pullOutNote(frame), null, 'with no note beside it');
    }, { gate: url => (failing && fills([url]).length ? 'fail' : null) });
  });

  await check('a held frame a reconnect\'s catch-up fills, after a Pull-out on it said the stage did not load, loses the note and the control says again what it does', async () => {
    const { boardId } = await post({ title: 'Filled by a catch-up', blocks: [yesNo('Right?'), stage('<p>STAGE-ZERO</p>')] });
    const stageId = stored(boardId).blocks[1].id;
    const { document, es } = await openTab(boardId);
    const { click } = await pageHarness();
    let failing = true;
    await withPageReads(async ({ settle }) => {
      await post({ boardId, title: 'Filled by a catch-up', blocks: [{ id: stageId, kind: 'html', html: '<p>STAGE-ONE</p>' }] });
      es.dispatch('open', '');
      await settle();
      const frame = frameOf(document, stageId);
      const control = frame.closest('.html-block').querySelector('.pull-out');
      const label = control.getAttribute('title');
      click(control);
      await settle();
      assert.match(pullOutNote(frame) ? pullOutNote(frame).textContent : '', /did not load/, 'setup failure: the press did not leave the did-not-load note');
      failing = false;
      es.dispatch('open', '');
      await settle();
      assert.match(frame.getAttribute('srcdoc') || '', /STAGE-ONE/, 'setup failure: the catch-up did not fill the frame');
      assert.equal(pullOutNote(frame), null, 'the note goes once the stage is in, whichever fill put it there');
      assert.equal(control.getAttribute('title'), label, 'and the control says again what it does');
      assert.equal(control.getAttribute('aria-label'), 'Open this stage full size', 'to a screen reader too');
    }, { gate: url => (failing && fills([url]).length ? 'fail' : null) });
  });

  await check('a round push that keeps a held frame keeps the still-loading note beside its Pull-out, and the control\'s words, while the fill a press started is out, until that fill lands the stage', async () => {
    const title = 'A push over a held Pull-out';
    const { boardId } = await post({ title, blocks: [yesNo('Right?'), stage('<p>STAGE-ZERO</p>')] });
    const stageId = stored(boardId).blocks[1].id;
    const { document, es } = await openTab(boardId);
    const sse = await openStream(boardId, '?stages=held');
    const { click } = await pageHarness();
    const { gate, release, fail } = fillGates();
    const amendStage = async () => {
      const pushed = nextEvent(sse, 'round');
      await post({ boardId, title, blocks: [{ id: stageId, kind: 'html', html: '<p>STAGE-ONE</p>' }] });
      await pushed;
    };
    const controlOf = frame => frame.closest('.html-block').querySelector('.pull-out');
    await withPageReads(async ({ reads, settle }) => {
      // The stage changes while the tab's stream is down: its catch-up holds the frame,
      // and the fill that catch-up sends fails.
      await amendStage();
      miss(sse);
      fail(0);
      es.dispatch('open', '');
      await settle();
      const frame = frameOf(document, stageId);
      assert.equal(frame.hasAttribute('data-held'), true, 'setup failure: the frame is not held');
      const label = controlOf(frame).getAttribute('title');
      click(controlOf(frame));
      await waitFor(() => fills(reads).length === 2, { what: 'the press\'s fill read' });
      assert.match(pullOutNote(frame)?.textContent || '', /still loading/, 'setup failure: the press left no still-loading note');
      // While that read is out, an amend re-posts the stage unchanged: its push holds the
      // frame, and the live frame stands in for it.
      await amendStage();
      deliver(sse, es);
      assert.equal(frameOf(document, stageId), frame, 'setup failure: the push did not keep the frame');
      assert.equal(frame.hasAttribute('data-held'), true, 'setup failure: the frame was filled before the read was let through');
      const note = pullOutNote(frame);
      assert.match(note?.textContent || '', /still loading/, 'the note still says the stage is loading');
      assert.equal(controlOf(frame).getAttribute('title'), note.textContent, 'and so does the control the push put in the corner');
      assert.equal(controlOf(frame).getAttribute('aria-label'), note.textContent, 'to a screen reader too');
      release(1);
      release(2);
      await settle();
      assert.match(frame.getAttribute('srcdoc') || '', /STAGE-ONE/, 'setup failure: the fill did not land the stage');
      assert.equal(pullOutNote(frame), null, 'the note goes once that fill lands the stage');
      assert.equal(controlOf(frame).getAttribute('title'), label, 'and the control says again what it does');
    }, { gate });
  });

  await check('filling one held frame reads that stage alone, not every stage on the board, and fills the frame with the stage the board holds, named by its sha', async () => {
    const pad = name => `<p>${name}</p><!--${'x'.repeat(200_000)}-->`;
    const names = ['STAGE-A', 'STAGE-B', 'STAGE-C', 'STAGE-D', 'STAGE-E'];
    const { boardId } = await post({ title: 'One of five', blocks: [yesNo('Right?'), ...names.map(n => stage(pad(n)))] });
    const blocks = stored(boardId).blocks.filter(b => b.kind === 'html');
    const { document, es } = await openTab(boardId);
    const others = blocks.filter((_, i) => i !== 2).map(b => frameOf(document, b.id));
    await withPageReads(async ({ reads, settle }) => {
      await post({ boardId, title: 'One of five', blocks: [{ id: blocks[2].id, kind: 'html', html: pad('STAGE-C-AMENDED') }] });
      const amended = stored(boardId).blocks.find(b => b.id === blocks[2].id);
      es.dispatch('open', '');
      await settle();
      assert.deepEqual(fills(reads), [`/b/${boardId}?stages=${amended.sha}`], 'one read, naming that stage alone');
      const answer = await (await daemonFetch(`${base}${fills(reads)[0]}`)).text();
      const markup = renderedMarkup(answer);
      assert.ok(markup.includes('STAGE-C-AMENDED'), 'the answer carries that stage whole');
      for (const n of names.filter(n => n !== 'STAGE-C')) assert.ok(!markup.includes(n), `and none of the others, ${n} included`);
      assert.ok(Buffer.byteLength(answer) < 300_000, `the answer is ${Buffer.byteLength(answer)} bytes, about one stage, not five`);
      const frame = frameOf(document, blocks[2].id);
      assert.equal(frame.hasAttribute('data-held'), false, 'the held frame is filled');
      assert.match(frame.getAttribute('srcdoc'), /STAGE-C-AMENDED/, 'with the stage the board holds now');
      assert.equal(frame.getAttribute('data-sha'), amended.sha, 'and named by its sha');
      blocks.filter((_, i) => i !== 2).forEach((b, i) => assert.equal(frameOf(document, b.id), others[i], 'the other stages keep their frames'));
    });
  });
}

runMain('held-stages', main, {
  cleanup: () => {
    for (const sse of streams) sse.req.destroy();
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
  },
});
