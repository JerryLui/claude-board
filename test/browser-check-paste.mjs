// Real-browser check for images on a round's answers and comments (src/ui.mjs, search
// "images pasted or dropped"): a PNG pasted or dropped on a note, a text answer and a
// block comment shows as a thumbnail before Send, its remove control takes it back,
// and Send posts each as a data: URL on its answer or comment. An image over the 10 MB
// limit, or a Send whose images add up past 20 MB, is refused in the page with a line
// naming the limit, nothing is posted and everything typed stays. The DOM stand-in has
// no clipboard, no drag and no image decoding (QUIRKS.md "The DOM stand-in's
// ceilings"); test/check-paste.mjs keeps what happens to the images after they land.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-paste.mjs
//
// Without Chrome it prints a skip line and exits 0.
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch port
// and a scratch store, headless Chrome over the DevTools Protocol. Paste and drop are
// Chrome's own ClipboardEvent and DragEvent carrying a DataTransfer of real Files,
// dispatched at the field. Send's request is caught in the page before it leaves and
// answered with a network failure, so the round stays open for the next row and what
// is asserted is the body the page built, not what a daemon kept of it.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile } from './support.mjs';
import { CHROME, guardRun, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-paste', `browser-check-paste: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-paste', { deadlineMs: 180000 });

// A 1x1 PNG: real enough for Chrome to decode as the thumbnail.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`;

const BOARD = {
  title: 'paste browser check',
  wait: true,
  blocks: [
    { kind: 'question', prompt: 'Keep the cap?', widget: 'single', options: [{ label: 'Keep' }, { label: 'Raise' }] },
    { kind: 'question', prompt: 'Say why', widget: 'text', options: [] },
    { kind: 'html', html: '<p>A mock to comment on.</p>' },
  ],
};

// Installed before the board's own scripts: every submit body, parsed, in
// window.__submits, the request itself failed as a dropped network would.
const SUBMIT_CATCHER = `(function () {
  window.__submits = [];
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (/\\/submit$/.test(url)) {
      window.__submits.push(JSON.parse(init.body));
      return Promise.reject(new TypeError('caught by the check'));
    }
    return realFetch.apply(this, arguments);
  };
})();`;

// Helpers in the tab. 'field(name)' is a composer's field: the note on the first
// question, the text answer, or the html block's comment input (opened first).
const PAGE_HELPERS = `(function () {
  var q1 = document.querySelector('.question-block[data-widget="single"]').getAttribute('data-block-id');
  var q2 = document.querySelector('.question-block[data-widget="text"]').getAttribute('data-block-id');
  var h = document.querySelector('.comment-btn').getAttribute('data-block-id');
  window.__keys = { note: 'note:' + q1, answer: 'answer:' + q2, comment: 'comment:' + h };
  window.__field = function (name) {
    if (name === 'note') return document.querySelector('textarea[data-note-for="' + q1 + '"]');
    if (name === 'answer') return document.querySelector('textarea[data-answer-for="' + q2 + '"]');
    var form = document.querySelector('form#comment-form-' + h);
    if (!form.classList.contains('open')) document.querySelector('.comment-btn').click();
    return form.querySelector('input[type=text]');
  };
  window.__png = function (bytes, name) {
    var data;
    if (bytes) {
      data = new Uint8Array(bytes);
      data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } else {
      data = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), function (c) { return c.charCodeAt(0); });
    }
    return new File([data], name || 'shot.png', { type: 'image/png' });
  };
  window.__give = function (name, how, bytes) {
    var el = window.__field(name);
    el.focus();
    var dt = new DataTransfer();
    dt.items.add(window.__png(bytes, how === 'drop' ? 'dropped.png' : 'image.png'));
    var ev = how === 'drop'
      ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  window.__thumbs = function (name) {
    return [].map.call(document.querySelectorAll('div.thumb-row[data-images-for="' + window.__keys[name] + '"] .thumb'), function (t) {
      var img = t.querySelector('img.thumb-img');
      return { caption: t.querySelector('.thumb-cap').textContent, decoded: img.complete && img.naturalWidth > 0,
        removable: !!t.querySelector('button.thumb-remove') };
    });
  };
  window.__refusal = function (name) {
    var p = document.querySelector('p.image-refusal[data-refusal-for="' + window.__keys[name] + '"]');
    return p ? p.textContent : null;
  };
  window.__type = function (name, text) {
    var el = window.__field(name);
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return true;
})()`;

const COMPOSERS = ['note', 'answer', 'comment'];

async function main() {
  const daemon = await startScratchDaemon('cb-paste');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const cookie = sessionToken(daemon.secret);

    await withChrome({ tag: 'cb-paste' }, async ({ send, onEvent }) => {
      const open = async () => {
        const posted = await postJson(`${origin}/api/board`, BOARD, daemon.secret);
        const tab = await openTab(send, onEvent, `${origin}${new URL(posted.url).pathname}`, cookie, {
          width: 1280, height: 900, theme: 'light', expr: PAGE_HELPERS,
          prepare: sp => sp('Page.addScriptToEvaluateOnNewDocument', { source: SUBMIT_CATCHER }),
        });
        assert.equal(tab.measured, true, 'setup: the helpers installed');
        return tab;
      };
      const thumbsSettle = (tab, name, n) => tab.until(`window.__thumbs(${JSON.stringify(name)}).length === ${n}`, `${name} showing ${n} thumbnail(s)`);
      const clickAt = async (tab, selector) => {
        const box = await tab.evalPage(`(function () {
          var el = document.querySelector(${JSON.stringify(selector)});
          el.scrollIntoView({ block: 'center' });
          var r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await tab.sp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        }
      };

      const tab = await open();
      try {
        for (const name of COMPOSERS) {
          await row(`a PNG pasted and a PNG dropped on the ${name} each show a removable thumbnail before Send`, async note => {
            assert.equal(await tab.evalPage(`window.__give('${name}', 'paste')`), true, 'the paste was taken, not left to the field');
            await thumbsSettle(tab, name, 1);
            assert.equal(await tab.evalPage(`window.__give('${name}', 'drop')`), true, 'the drop was taken, not opened as a page');
            await thumbsSettle(tab, name, 2);
            await tab.until(`window.__thumbs('${name}').every(function (t) { return t.decoded; })`, 'both thumbnails decoding');
            const thumbs = await tab.evalPage(`window.__thumbs('${name}')`);
            note(thumbs.map(t => t.caption).join(' | '));
            assert.match(thumbs[0].caption, /^pasted-\d+\.png, 1 KB$/);
            assert.equal(thumbs[1].caption, 'dropped.png, 1 KB');
            assert.deepEqual(thumbs.map(t => t.removable), [true, true]);
          });
        }

        await row('a click on a thumbnail\'s remove control drops that image and keeps the other', async () => {
          await clickAt(tab, `div.thumb-row[data-images-for="${await tab.evalPage('window.__keys.note')}"] .thumb:first-child button.thumb-remove`);
          await thumbsSettle(tab, 'note', 1);
          assert.equal((await tab.evalPage(`window.__thumbs('note')`))[0].caption, 'dropped.png, 1 KB');
        });

        await row('Send posts each image as a data: URL on its own answer or comment', async note => {
          await tab.evalPage(`(function () {
            window.__type('note', 'see the shot');
            window.__type('answer', 'because');
            window.__type('comment', 'this mock');
            document.querySelector('form#comment-form-' + window.__keys.comment.slice(8) + ' button[type=submit]').click();
            [].find.call(document.querySelectorAll('.choice-single'), function (b) { return b.textContent.trim() === 'Keep'; }).click();
            return true;
          })()`);
          await tab.until(`document.querySelector('.comment-item.comment-pending .thumb-row') !== null`, 'the queued comment showing its images');
          await clickAt(tab, 'button#send-btn');
          await tab.until('window.__submits.length === 1', 'a submit');
          const body = await tab.evalPage('window.__submits[0]');
          const keys = await tab.evalPage('window.__keys');
          const imagesOf = id => body.answers.find(a => a.id === id).images;
          note(`answers ${body.answers.map(a => `${a.id}:${(a.images || []).length}`).join(', ')}; comments ${body.comments.map(c => (c.images || []).length).join(', ')}`);
          assert.deepEqual(imagesOf(keys.note.slice(5)), [PNG_URL], 'the note\'s one image left after the remove');
          assert.deepEqual(imagesOf(keys.answer.slice(7)), [PNG_URL, PNG_URL], 'the text answer\'s two');
          assert.equal(body.comments.length, 1);
          assert.equal(body.comments[0].text, 'this mock');
          assert.deepEqual(body.comments[0].images, [PNG_URL, PNG_URL]);
        });
      } finally {
        await tab.close();
      }

      const big = await open();
      try {
        await row('an 11 MB image is refused as it lands, naming the limit; nothing is posted and the typed note stays', async () => {
          await big.evalPage(`window.__type('note', 'typed before the big one')`);
          assert.equal(await big.evalPage(`window.__give('note', 'paste', 11 * 1024 * 1024)`), true);
          const said = await big.until(`window.__refusal('note')`, 'the refusal');
          assert.equal(said, 'This image is 11 MB; the limit is 10 MB. Nothing was sent; your answers are kept.');
          assert.deepEqual(await big.evalPage(`window.__thumbs('note')`), []);
          assert.equal(await big.evalPage(`window.__field('note').value`), 'typed before the big one');
          assert.deepEqual(await big.evalPage('window.__submits'), []);
        });

        await row('three 7 MB images, 21 MB in one Send, are refused at Send, naming the limit; nothing is posted and every answer stays', async () => {
          for (const name of COMPOSERS) {
            await big.evalPage(`window.__type('${name}', 'kept ${name}')`);
            await big.evalPage(`window.__give('${name}', 'paste', 7 * 1024 * 1024)`);
            await thumbsSettle(big, name, 1);
          }
          await big.evalPage(`document.querySelector('form#comment-form-' + window.__keys.comment.slice(8) + ' button[type=submit]').click()`);
          await big.evalPage(`[].find.call(document.querySelectorAll('.choice-single'), function (b) { return b.textContent.trim() === 'Raise'; }).click()`);
          await clickAt(big, 'button#send-btn');
          const said = await big.until(`/limit/.test(document.querySelector('span#send-status').textContent) && document.querySelector('span#send-status').textContent`, 'the Send refusal');
          assert.equal(said, 'The images in this Send add up to 21 MB; the limit is 20 MB per Send. Nothing was sent; your answers are kept.');
          assert.deepEqual(await big.evalPage('window.__submits'), []);
          assert.deepEqual(await big.evalPage('[window.__field("note").value, window.__field("answer").value]'), ['kept note', 'kept answer']);
          assert.equal(await big.evalPage('document.querySelectorAll(".comment-item.comment-pending .thumb").length'), 1, 'the queued comment keeps its image');
          assert.equal(await big.evalPage('document.querySelector("button#send-btn").disabled'), false, 'Send is still on offer');
        });
      } finally {
        await big.close();
      }
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
