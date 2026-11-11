// Images given to a round's answers before Send (src/ui.mjs, search "images pasted or
// dropped"), driven through the real client script in the DOM stand-in: what Send posts
// for them, and what an amend's re-render keeps. Pasting, dropping, the thumbnail's
// remove and the size refusals need a real browser's clipboard, drag and image decoding:
// test/browser-check-paste.mjs keeps those, run by hand.

import assert from 'node:assert/strict';
import { createBoard, amendRound } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { buildRoundPushPayload } from '../src/server.mjs';
import { MAX_IMAGE_BYTES } from '../src/post-limit.mjs';
import { StandInEvent } from './dom-stand-in.mjs';
import { checkAsync, finish, flush, pageHarness } from './support.mjs';

const { loadBoardWithEventSource, answerSingle, click, withFetchCapture } = await pageHarness();

// Two different images, so an order or a mix-up shows.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');
const asUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

const single = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });

/** Pastes one file on `el` as the clipboard would hand it over, and lets it be read. */
async function paste(el, bytes, type) {
  assert.ok(el, 'setup failure: no field to paste on');
  el.dispatchEvent(new StandInEvent('paste', { clipboardData: { files: [new File([bytes], 'clip', { type })] } }));
  await flush();
}

function send(document) {
  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'setup failure: every question answered, so Send must post once');
  return calls[0].body;
}

await checkAsync('Send posts a text answer\'s and its note\'s images on that answer, the answer\'s first, and no images key on an answer or a comment given none', async () => {
  const board = createBoard({ title: 'Images on Send', blocks: [
    single('Q1: ship it?'),
    { kind: 'question', prompt: 'Q2: why?', widget: 'text', options: [] },
    { kind: 'html', html: '<p>mock</p>' },
  ] });
  const [q1, q2, h] = board.blocks.map(b => b.id);
  const { document } = loadBoardWithEventSource(renderBoardPage(board));
  const answerBox = document.querySelector(`textarea[data-answer-for="${q2}"]`);
  answerBox.value = 'because';
  answerBox.dispatchEvent(new StandInEvent('input'));
  await paste(document.querySelector(`textarea[data-note-for="${q2}"]`), GIF, 'image/gif');
  await paste(answerBox, PNG, 'image/png');
  answerSingle(document.querySelector(`.question-block[data-block-id="${q1}"]`), 'Yes');
  click(document.querySelector(`.comment-btn[data-block-id="${h}"]`));
  const form = document.querySelector(`form#comment-form-${h}`);
  form.querySelector('input[type=text]').value = 'plain words';
  form.dispatchEvent(new StandInEvent('submit'));

  const body = send(document);
  const byId = id => body.answers.find(a => a.id === id);
  assert.deepEqual(byId(q2).images, [asUrl('image/png', PNG), asUrl('image/gif', GIF)]);
  assert.equal('images' in byId(q1), false, 'an answer given no image carries no images key');
  assert.equal(body.comments.length, 1, 'setup failure: the comment must be queued');
  assert.equal('images' in body.comments[0], false, 'a comment given no image carries no images key');
});

await checkAsync('the paste hint under every composer names the one-image limit the daemon enforces', async () => {
  const board = createBoard({ title: 'Hint', blocks: [{ kind: 'question', prompt: 'Q1: why?', widget: 'text', options: [] }, { kind: 'html', html: '<p>mock</p>' }] });
  const { document } = loadBoardWithEventSource(renderBoardPage(board));
  const hints = document.querySelectorAll('p.paste-hint').map(p => p.textContent);
  assert.equal(hints.length, 2, 'setup failure: the note and the mock\'s comment form each carry the hint');
  for (const hint of hints) assert.equal(hint, `Paste or drop images, up to ${MAX_IMAGE_BYTES / (1024 * 1024)} MB each`);
});

await checkAsync('a comment of an image and no words queues, and Send posts it with empty text and the image', async () => {
  const board = createBoard({ title: 'An image alone', blocks: [single('Q1: ship it?'), { kind: 'html', html: '<p>mock</p>' }] });
  const [q1, h] = board.blocks.map(b => b.id);
  const { document } = loadBoardWithEventSource(renderBoardPage(board));
  click(document.querySelector(`.comment-btn[data-block-id="${h}"]`));
  const form = document.querySelector(`form#comment-form-${h}`);
  await paste(form.querySelector('input[type=text]'), PNG, 'image/png');
  form.dispatchEvent(new StandInEvent('submit'));
  answerSingle(document.querySelector(`.question-block[data-block-id="${q1}"]`), 'Yes');
  const { comments } = send(document);
  assert.equal(comments.length, 1, 'the image alone queued a comment');
  assert.equal(comments[0].text, '');
  assert.deepEqual(comments[0].images, [asUrl('image/png', PNG)]);
});

await checkAsync('an amend that re-renders a question keeps the thumbnails its note holds, and Send still posts them', async () => {
  const board = createBoard({ title: 'Images across an amend', blocks: [single('Q1: ship it?')] });
  const [q1] = board.blocks.map(b => b.id);
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  await paste(document.querySelector(`textarea[data-note-for="${q1}"]`), PNG, 'image/png');
  const thumbs = () => document.querySelectorAll(`div.thumb-row[data-images-for="note:${q1}"] .thumb`);
  assert.equal(thumbs().length, 1, 'setup failure: the paste must show a thumbnail');
  const rowBefore = document.querySelector(`div.thumb-row[data-images-for="note:${q1}"]`);

  amendRound(board, { blocks: [{ id: q1, ...single('Q1: ship it now?') }] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 1, 'amend', [q1])));
  assert.notEqual(document.querySelector(`div.thumb-row[data-images-for="note:${q1}"]`), rowBefore, 'setup failure: the amend must re-render Q1');
  assert.equal(thumbs().length, 1, 'the re-rendered note shows the image the tab still holds');

  answerSingle(document.querySelector(`.question-block[data-block-id="${q1}"]`), 'No');
  assert.deepEqual(send(document).answers[0].images, [asUrl('image/png', PNG)]);
});

finish();
