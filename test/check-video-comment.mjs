// A comment on a video records the second it was paused at. The reviewer pauses, turns
// comment mode on and clicks the video; the time arrives with the comment instead of being
// typed, and the agent's packet carries it in the comment's anchor:
//
//   { kind: 'dom', ref, hint: 'Criterion 2 clip at 0:07', time: 7 }
//
// Driven end to end the way test/check-anchor-robustness.mjs drives a dom anchor: a real
// daemon serves the page, the real page and stage scripts run in test/dom-stand-in.mjs
// (which has no media, so a check sets the video's `currentTime` itself), the page's own
// Send body goes to the real submit route, and the packet comes back out of `/wait`.
// PROTOCOL.md "Answers, comments, anchors" holds the rule: src/anchor.mjs's videoIdentity,
// videoSecond and videoTimeSuffix, shared by the stage, the page and src/board.mjs.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';
import { StandInEvent, parseHTML } from './dom-stand-in.mjs';
import { check, pageHarness, postBoard, runMain, secretFetch, secretHome, sleep, writeHeaders } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-video-comment-', { secret: 'v'.repeat(64) });
const fetch = secretFetch(SECRET);
const { loadBoard, enableCommentMode, click, withFetchCapture } = await pageHarness();

// The video's fallback text is what its textContent reads, and what a hint built the old
// way would have named it by; the label is what the reviewer sees it as.
const STAGE = '<video aria-label="Criterion 2 clip" controls>Your browser cannot play this clip.</video><button>Send</button>';
// Two videos whose names an attribute's quoted value spells a decoy inside: the first has
// only a title, which reads "aria-label=x"; the second's title reads "aria-label=y" ahead of
// its real aria-label.
const DECOY_STAGE = '<video title="Demo aria-label=x" controls></video><video title="x aria-label=y" aria-label="Real" controls></video>';

let server, base;

/** The page as the daemon serves it, loaded in the stand-in with comment mode on and its
 * stage's srcdoc loaded. Returns `{ document, frame, video, videos, button, form }`:
 * `video` is the stage's first video, `button` its button or null. */
async function openPage(boardId, blockId) {
  const res = await fetch(`${base}/b/${boardId}`);
  assert.equal(res.status, 200, 'setup failure: the board page must render');
  const document = loadBoard(await res.text());
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage on the page');
  frame.loadSrcdoc();
  const videos = frame.contentDocument.querySelectorAll('video');
  const button = frame.contentDocument.querySelector('button');
  assert.ok(videos.length, 'setup failure: the stage must carry a video');
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, 'setup failure: no comment form for the html block');
  return { document, frame, video: videos[0], videos, button, form };
}

/** Dispatch a `type` event at `el` in the stage and return it, so a row can read
 * `defaultPrevented`. */
function fire(el, type) {
  const ev = new StandInEvent(type);
  el.dispatchEvent(ev);
  return ev;
}

/** Click `el` in the stage and return the click event. */
function clickIn(el) {
  return fire(el, 'click');
}

/** Press Send and return the body the page posts. */
function sendBody(document) {
  const [{ body }] = withFetchCapture(() => click(document.getElementById('send-btn')));
  return body;
}

/** Type `text` into the open form and submit it, queueing the comment. */
function queue(form, text) {
  assert.equal(form.classList.contains('open'), true, 'setup failure: the comment form must be open to queue a comment');
  form.querySelector('input[type=text]').value = text;
  form.dispatchEvent(new StandInEvent('submit'));
}

/** Post an ordinary board carrying the video stage (`html`, STAGE by default). A trailing markdown block keeps it
 * ordinary: a lone html block is a page board, whose comments wait on `wait: true`, which
 * is not this file's subject. Returns `{ boardId, blockId }`, the html block's id. */
async function postVideoBoard(port, html = STAGE) {
  const { boardId } = await postBoard(port, SECRET, { title: 'Evidence: criterion 2', blocks: [{ kind: 'html', html }, { kind: 'markdown', text: 'An ordinary board.' }] });
  return { boardId, blockId: readBoard(boardId, home).blocks[0].id };
}

/** Submit `body` to round 1 of `boardId` over the real route and return the packet the
 * agent's blocked `/wait` receives. */
async function submitAndWait(boardId, body) {
  const waitPromise = fetch(`${base}/api/board/${boardId}/wait?round=1`).then(r => r.json());
  await sleep(150);
  const submitted = await fetch(`${base}/api/board/${boardId}/submit`, { method: 'POST', headers: writeHeaders(SECRET), body: JSON.stringify(body) });
  assert.equal(submitted.status, 200, 'setup failure: the submit must be accepted');
  return waitPromise;
}

async function main() {
  let port;
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  const { boardId, blockId } = await postVideoBoard(port);

  let body;
  await check('a comment-mode click on a video paused at 7.4s posts its name and second 7 over the stage channel, and the page labels the comment "Criterion 2 clip at 0:07"', async () => {
    const { document, video, button, form } = await openPage(boardId, blockId);
    const clicks = [];
    document.defaultView.addEventListener('message', ev => { if (ev.data && ev.data.type === 'click') clicks.push(ev.data); });

    video.currentTime = 7.4;
    const ev = clickIn(video);
    assert.equal(clicks.length, 1, 'the click must reach the page over the stage channel');
    assert.equal(clicks[0].time, 7, 'the stage must send the whole second the video shows');
    assert.equal(clicks[0].text, 'Criterion 2 clip', 'the stage must name the video by its aria-label, never its fallback text');
    assert.equal(ev.defaultPrevented, true, 'a comment-mode click on a video must not also play or pause it, or the second moves');
    assert.equal(form.getAttribute('data-anchor-label'), 'Criterion 2 clip at 0:07');
    assert.equal(document.getElementById('comment-target-' + blockId).textContent, 'commenting on: Criterion 2 clip at 0:07');
    queue(form, 'the dialog has not closed yet here');
    const pending = document.querySelector('.comment-item.comment-pending .comment-anchor');
    assert.equal(pending && pending.textContent, '#1 · Criterion 2 clip at 0:07', 'the queued comment\'s label must name the second');

    // The same video at another second is a second comment, not an edit of the first.
    video.currentTime = 12.9;
    clickIn(video);
    assert.equal(form.getAttribute('data-anchor-label'), 'Criterion 2 clip at 0:12');
    queue(form, 'and here the spinner is gone');

    // A non-video element in the same stage keeps today's anchor: its own text, no time.
    button.currentTime = 3;
    clickIn(button);
    assert.equal(form.getAttribute('data-anchor-label'), 'Send');
    assert.equal(form.getAttribute('data-anchor-time'), null, 'a non-video click must open the form with no time on it');
    queue(form, 'rename this button');

    assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 3, 'all three comments must be queued');
    body = sendBody(document);
    assert.deepEqual(body.comments.map(c => c.anchor), [
      { kind: 'dom', ref: '1', hint: 'Criterion 2 clip at 0:07', time: 7 },
      { kind: 'dom', ref: '1', hint: 'Criterion 2 clip at 0:12', time: 12 },
      { kind: 'dom', ref: '2', hint: 'Send' },
    ], 'the page must post each anchor with the second beside its label, and none on the button');
  });

  await check('the agent\'s packet carries the second in the anchor and its label "Criterion 2 clip at 0:07", resolved against the snapshot', async () => {
    assert.ok(body, 'setup failure: the previous check must have captured the page\'s Send body');
    const packet = await submitAndWait(boardId, body);
    const byText = text => packet.comments.find(c => c.text === text);

    const at7 = byText('the dialog has not closed yet here');
    assert.deepEqual(at7.anchor, { kind: 'dom', ref: '1', hint: 'Criterion 2 clip at 0:07', time: 7 });
    assert.equal(at7.lost, undefined, 'the video comment must resolve against the snapshot, not report lost');
    const at12 = byText('and here the spinner is gone');
    assert.deepEqual(at12.anchor, { kind: 'dom', ref: '1', hint: 'Criterion 2 clip at 0:12', time: 12 });
    assert.equal(at12.lost, undefined);
    const onButton = byText('rename this button');
    assert.deepEqual(onButton.anchor, { kind: 'dom', ref: '2', hint: 'Send' }, 'a non-video anchor carries no time');
    assert.equal(onButton.lost, undefined);

    // The page's own comment list after the send, rendered by the daemon.
    const page = parseHTML(await (await fetch(`${base}/b/${boardId}`)).text());
    const label = page.querySelectorAll('.comment-anchor').find(el => el.textContent.endsWith('at 0:07'));
    assert.ok(label, 'the sent page must list the video comment');
    assert.equal(label.textContent, '#1 · Criterion 2 clip at 0:07');
    assert.equal(label.classList.contains('comment-lost'), false, 'and must not draw it as lost');
  });

  await check('a sent comment at 0:07 marks that second sent in the stage: at 0:07 the video hovers as already commented and a click opens nothing, at 0:30 it hovers as a target and opens a new comment', async () => {
    const { document, video, form } = await openPage(boardId, blockId);
    video.currentTime = 7.6;
    fire(video, 'mouseover');
    assert.equal(video.classList.contains('cb-anchor-sent'), true, 'the second that already carries a sent comment must hover as already commented, or its click is a silent drop');
    assert.equal(video.classList.contains('cb-anchor-hover'), false);

    // The second moves under a resting pointer (the video plays, by autoplay or the stage's
    // script), and a browser fires timeupdate as it moves: the mark follows the second.
    video.currentTime = 30;
    fire(video, 'timeupdate');
    assert.equal(video.classList.contains('cb-anchor-hover'), true, 'another second on the same video must hover as a target');
    assert.equal(video.classList.contains('cb-anchor-sent'), false);
    video.currentTime = 7.2;
    fire(video, 'timeupdate');
    assert.equal(video.classList.contains('cb-anchor-sent'), true, 'back at the sent second, the video must hover as already commented again');

    clickIn(video);
    assert.equal(form.classList.contains('open'), false, 'the second that already carries a sent comment must not open another');

    video.currentTime = 30;
    clickIn(video);
    assert.equal(form.classList.contains('open'), true, 'another second on the same video must open the form');
    assert.equal(form.getAttribute('data-anchor-label'), 'Criterion 2 clip at 0:30');
    assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'setup failure: nothing is queued until the form is submitted');
  });

  await check('a stage message\'s time is kept only as a whole second from 0 to 86400 on a video, labelled m:ss or h:mm:ss, and dropped otherwise', async () => {
    const { frame, form } = await openPage(boardId, blockId);
    const forge = (tag, time) => frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'click', ref: '1', tag, text: 'Criterion 2 clip', time }, '*');
    const rows = [
      ['VIDEO', 0, 'Criterion 2 clip at 0:00', '0'],
      ['VIDEO', 3725.9, 'Criterion 2 clip at 1:02:05', '3725'],
      ['VIDEO', 86400, 'Criterion 2 clip at 24:00:00', '86400'],
      ['VIDEO', '7', 'Criterion 2 clip', null],
      ['VIDEO', NaN, 'Criterion 2 clip', null],
      ['VIDEO', -1, 'Criterion 2 clip', null],
      ['VIDEO', 86400.5, 'Criterion 2 clip', null],
      ['VIDEO', Infinity, 'Criterion 2 clip', null],
      ['BUTTON', 5, 'Criterion 2 clip', null],
    ];
    for (const [tag, time, label, stored] of rows) {
      forge(tag, time);
      const row = `${tag} time ${String(time)}`;
      assert.equal(form.classList.contains('open'), true, `${row}: setup failure: the click must open the form`);
      assert.equal(form.getAttribute('data-anchor-label'), label, `${row}: label`);
      assert.equal(form.getAttribute('data-anchor-time'), stored, `${row}: time on the form`);
    }
  });

  await check('a forged time on a submitted anchor (string, negative, over 86400, null) is dropped from the packet\'s anchor, never coerced', async () => {
    // Its own board: a sent comment on the video above would change what the rows before
    // this one see. JSON has no NaN, so a NaN arrives here as null.
    const forgedBoard = await postVideoBoard(port);
    const comments = ['7', -1, 86400.5, null].map(time => ({
      blockId: forgedBoard.blockId, anchor: { kind: 'dom', ref: '1', hint: 'Criterion 2 clip', time }, text: `forged ${JSON.stringify(time)}`,
    }));
    const packet = await submitAndWait(forgedBoard.boardId, { round: 1, action: 'send', answers: [], comments });
    assert.equal(packet.comments.length, comments.length, 'every forged comment is still stored');
    for (const c of packet.comments) {
      assert.deepEqual(c.anchor, { kind: 'dom', ref: '1', hint: 'Criterion 2 clip' }, `${c.text}: the time must be dropped`);
      assert.equal(c.lost, undefined, `${c.text}: the untimed anchor still resolves`);
    }
  });

  await check('in comment mode a video carries no native controls, and comment mode ending gives them back only to the videos that had them', async () => {
    // A press on native controls seeks and never reaches the stage (QUIRKS.md "A press on a
    // video's native controls never reaches the page"); the stand-in has no controls to
    // press, so test/browser-check-video.mjs presses the real timeline in Chrome. This row
    // holds the attribute itself. The second video carries no controls and must not gain any.
    const pressBoard = await postVideoBoard(port, STAGE + '<video aria-label="Bare clip"></video>');
    const { document, videos } = await openPage(pressBoard.boardId, pressBoard.blockId);
    const [video, bare] = videos;
    assert.equal(video.hasAttribute('controls'), false, 'in comment mode a video must carry no native controls, or a press on them seeks');

    click(document.getElementById('comment-mode-toggle'));
    assert.equal(video.hasAttribute('controls'), true, 'with comment mode off the video must get its controls back');
    assert.equal(bare.hasAttribute('controls'), false, 'a video that had no controls must not gain any');
  });

  await check('an untimed comment stored before a video was named by its label, hinted with its fallback text, still resolves; a hint naming neither its label nor its text is lost', async () => {
    // Before a video comment carried its second, the stage named a video by its text, so a
    // stored untimed hint on STAGE's video reads its fallback text.
    const legacyBoard = await postVideoBoard(port);
    const rows = [
      ['Your browser cannot play this clip.', false],
      ['Criterion 2 clip', false],
      ['Some other clip', true],
    ];
    const comments = rows.map(([hint]) => ({ blockId: legacyBoard.blockId, anchor: { kind: 'dom', ref: '1', hint }, text: `on "${hint}"` }));
    const packet = await submitAndWait(legacyBoard.boardId, { round: 1, action: 'send', answers: [], comments });
    for (const [hint, lost] of rows) {
      const c = packet.comments.find(x => x.anchor.hint === hint);
      assert.ok(c, `${hint}: setup failure: the comment must be stored`);
      assert.equal(c.lost !== undefined, lost, `${hint}: lost`);
    }
  });

  await check('a video is named by its own aria-label or title, never by one spelled inside another attribute\'s quoted value: each comment resolves under the name the stage sends', async () => {
    const decoyBoard = await postVideoBoard(port, DECOY_STAGE);
    const { document, videos, form } = await openPage(decoyBoard.boardId, decoyBoard.blockId);
    videos[0].currentTime = 7;
    clickIn(videos[0]);
    assert.equal(form.getAttribute('data-anchor-label'), 'Demo aria-label=x at 0:07', 'setup failure: the stage names a title-only video by its title');
    queue(form, 'the demo stalls');
    videos[1].currentTime = 3;
    clickIn(videos[1]);
    assert.equal(form.getAttribute('data-anchor-label'), 'Real at 0:03', 'setup failure: the stage names the video by its aria-label');
    queue(form, 'the real one is fine');

    const packet = await submitAndWait(decoyBoard.boardId, sendBody(document));
    assert.deepEqual(packet.comments.map(c => [c.anchor.hint, c.lost]), [
      ['Demo aria-label=x at 0:07', undefined],
      ['Real at 0:03', undefined],
    ], 'each video comment must resolve against the snapshot under the name the stage sent');
  });
}

runMain('video-comment', main, {
  cleanup: () => {
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
  },
});
