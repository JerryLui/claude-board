// Images pasted into an answer or a comment, from the daemon's side: a submit's `images`
// (data URLs) are checked as real images of an allowed type and within the size limits,
// kept beside their board at `pages/<boardId>/<name>`, named by absolute path in the
// packets `ask` and `read` hand the agent, drawn read-only on the sent round's page, and
// removed with their board by a delete or a prune (PROTOCOL.md "Submit", "Packet").
//
// Real daemon on an ephemeral port against its own temp store and the real stdio shim, as
// test/check-mcp.mjs runs them: the packet the agent reads is the shim's tool result, so
// that is what is asserted. Every file assertion reads the store directory itself.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { deleteBoard, pruneStore, readBoard } from '../src/store.mjs';
import { MAX_IMAGE_BYTES, MAX_SEND_IMAGE_BYTES } from '../src/post-limit.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { check, runMain, secretHome, secretFetch, writeHeaders, spawnShim, withTimeout, sleep, postBoard, rawRequest } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-images-', { secret: 'e'.repeat(64) });
const fetch = secretFetch(SECRET);

// A real 1x1 image of each allowed type, and the name each is stored under: the first 16
// hex of its sha256 and its extension, written out, since boards already stored name
// their images in that shape.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const NAME = { png: 'c414cd0e204de974.png', gif: 'ef1955ae757c8b96.gif', jpg: '9650f149d622055c.jpg', webp: '86be52bdb7547413.webp' };
const dataUrl = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;
/** A PNG-headed buffer of `size` bytes: the check reads the leading bytes and the size. */
const pngOfSize = size => { const b = Buffer.alloc(size); PNG.copy(b, 0, 0, 8); return b; };

const boardsDir = path.join(home, 'boards');
const imagesDir = id => path.join(home, 'pages', id);
const boardIds = () => new Set(existsSync(boardsDir) ? readdirSync(boardsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : []);
const QUESTION = { kind: 'question', prompt: 'Looks right?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };

let server, port, base, shim;

async function newBoardId(known) {
  for (let i = 0; i < 250; i++) {
    for (const id of boardIds()) if (!known.has(id)) return id;
    await sleep(20);
  }
  throw new Error('timed out waiting for the ask to post its board');
}

function submit(boardId, body) {
  return fetch(`${base}/api/board/${boardId}/submit`, { method: 'POST', headers: writeHeaders(SECRET), body: JSON.stringify({ action: 'send', comments: [], ...body }) });
}

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;
  shim = spawnShim({ CLAUDE_BOARD_HOME: home, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_NO_OPEN: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_BOARD_PROGRESS_MS: '80' });

  let boardId, diagramId, pngPath, gifPath, jpgPath, webpPath;

  await check('ask: a Send with answer images of PNG, JPEG and WebP and a GIF comment image hands the agent each file\'s absolute path, stored beside the board', async () => {
    const known = boardIds();
    const call = shim.request('tools/call', { name: 'ask', arguments: { title: 'Images', blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  a --> b' }, QUESTION] } });
    boardId = await newBoardId(known);
    diagramId = readBoard(boardId, home).blocks[0].id;
    const r = await submit(boardId, {
      round: 1,
      answers: [{ id: 'q1', status: 'answered', choice: 'No', note: 'see the shot', images: [dataUrl('png', PNG), dataUrl('jpeg', JPEG), dataUrl('webp', WEBP)] }],
      comments: [{ blockId: diagramId, anchor: { kind: 'block' }, text: 'this one too', images: [dataUrl('gif', GIF)] }],
    });
    assert.equal(r.status, 200, await r.text());
    const result = (await withTimeout(call, 8000, 'the ask did not return after the Send')).result;
    assert.equal(result.isError, false, result.content[0].text);

    [pngPath, gifPath, jpgPath, webpPath] = [NAME.png, NAME.gif, NAME.jpg, NAME.webp].map(n => path.join(imagesDir(boardId), n));
    assert.deepEqual(result.answers[0].images, [pngPath, jpgPath, webpPath]);
    assert.deepEqual(result.comments[0].images, [gifPath]);
    assert.deepEqual(readFileSync(pngPath), PNG, 'the path the agent is given opens to the pasted bytes');
    assert.deepEqual(readFileSync(gifPath), GIF);
    assert.deepEqual(readFileSync(jpgPath), JPEG);
    assert.deepEqual(readFileSync(webpPath), WEBP);
    assert.deepEqual(readdirSync(imagesDir(boardId)).sort(), Object.values(NAME).sort());
    // The text channel is the one no client drops, so the paths ride it too.
    assert.ok(result.content[0].text.includes(`[images: ${[pngPath, jpgPath, webpPath].join(', ')}]`), result.content[0].text);
    assert.ok(result.content[0].text.includes(`[images: ${gifPath}]`), result.content[0].text);
    // The board keeps the names, never a path or the bytes.
    const stored = readBoard(boardId, home);
    assert.deepEqual(stored.answers.q1.images, [NAME.png, NAME.jpg, NAME.webp]);
    assert.deepEqual(stored.comments[0].images, [NAME.gif]);
  });

  await check('read: the same answer and comment name the same absolute paths', async () => {
    const result = (await withTimeout(shim.request('tools/call', { name: 'read', arguments: { board: boardId } }), 8000, 'read did not answer')).result;
    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(result.answers.find(a => a.id === 'q1').images, [pngPath, jpgPath, webpPath]);
    assert.deepEqual(result.comments[0].images, [gifPath]);
    assert.ok(result.content[0].text.includes(`[images: ${[pngPath, jpgPath, webpPath].join(', ')}]`), result.content[0].text);
  });

  await check('a text-only Send\'s packet carries no images key on its answer or comment, an answer sent with images: null included', async () => {
    const call = shim.request('tools/call', { name: 'ask', arguments: { title: 'Text only', blocks: [QUESTION] } });
    let round;
    for (let i = 0; i < 250 && !round; i++) {
      round = readBoard(boardId, home).rounds.find(r => r.n === 2);
      if (!round) await sleep(20);
    }
    assert.ok(round, 'setup: the second ask must add round 2 to the same board');
    const qid = readBoard(boardId, home).blocks.find(b => b.kind === 'question' && b.round === 2).id;
    const r = await submit(boardId, { round: 2, answers: [{ id: qid, status: 'answered', choice: 'Yes', note: '', images: null }], comments: [{ blockId: qid, anchor: { kind: 'block' }, text: 'words only' }] });
    assert.equal(r.status, 200, await r.text());
    const result = (await withTimeout(call, 8000, 'the second ask did not return')).result;
    assert.deepEqual(result.answers.map(a => 'images' in a), [false]);
    assert.deepEqual(result.comments.map(c => 'images' in c), [false]);
    assert.ok(!result.content[0].text.includes('[images:'), result.content[0].text);
  });

  await check('a round sent with images that no packet carried rides the next round\'s packet with each image\'s absolute path, on its answer and its comment', async () => {
    const first = await postBoard(port, SECRET, { title: 'Owed', blocks: [QUESTION] });
    const qid = readBoard(first.boardId, home).blocks.find(b => b.kind === 'question').id;
    // Its wait ends unanswered, on a short cap, as an agent's does before a late Send.
    const cap = process.env.CLAUDE_BOARD_TIMEOUT_MS;
    process.env.CLAUDE_BOARD_TIMEOUT_MS = '250';
    try {
      assert.equal((await (await fetch(`${base}/api/board/${first.boardId}/wait?round=1`)).json()).status, 'timeout');
    } finally {
      if (cap === undefined) delete process.env.CLAUDE_BOARD_TIMEOUT_MS;
      else process.env.CLAUDE_BOARD_TIMEOUT_MS = cap;
    }
    const r = await submit(first.boardId, {
      round: 1,
      answers: [{ id: qid, status: 'answered', choice: 'No', note: 'late', images: [dataUrl('png', PNG)] }],
      comments: [{ blockId: qid, anchor: { kind: 'block' }, text: 'late comment', images: [dataUrl('gif', GIF)] }],
    });
    assert.equal(r.status, 200, await r.text());
    const next = await postBoard(port, SECRET, { boardId: first.boardId, title: 'Next', blocks: [{ kind: 'markdown', text: 'carrying on' }], noWait: true });
    assert.equal(next.round, 2);
    const dir = imagesDir(first.boardId);
    assert.deepEqual(next.answers.map(a => [a.round, a.images]), [[1, [path.join(dir, NAME.png)]]]);
    assert.deepEqual(next.comments.map(c => [c.round, c.images]), [[1, [path.join(dir, NAME.gif)]]]);
  });

  await check('the sent round\'s page draws each image under its answer or its comment, from the board\'s folder, served and from Finder alike', async () => {
    const src = name => `${boardId}/${name}`;
    const pngSrc = src(NAME.png);
    const page = parseHTML(await (await fetch(`${base}/b/${boardId}`)).text());
    const srcs = sel => page.querySelectorAll(`${sel} .sent-images img`).map(i => i.getAttribute('src'));
    assert.deepEqual(srcs('section.question-block[data-block-id="q1"] .note-field'), [NAME.png, NAME.jpg, NAME.webp].map(src), 'the answer\'s images, under its note');
    assert.deepEqual(srcs(`.comment-item[data-block-id="${diagramId}"]`), [src(NAME.gif)], 'the comment\'s image, in its comment');
    // Served: the page is `/b/<id>`, so the relative src is `/b/<id>/<name>`.
    for (const [name, type, bytes] of [[NAME.png, 'image/png', PNG], [NAME.jpg, 'image/jpeg', JPEG], [NAME.webp, 'image/webp', WEBP], [NAME.gif, 'image/gif', GIF]]) {
      const img = await fetch(new URL(src(name), `${base}/b/${boardId}`));
      assert.equal(img.status, 200, name);
      assert.equal(img.headers.get('content-type'), type, name);
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), bytes, name);
    }
    // From Finder: the page file is `pages/<id>.html`, so the same src is the stored file.
    const filed = readFileSync(path.join(home, 'pages', `${boardId}.html`), 'utf8');
    assert.ok(filed.includes(`<img src="${pngSrc}"`));
    assert.ok(existsSync(path.join(home, 'pages', pngSrc)));
    // Gated like the page: no credential, no image.
    assert.equal((await rawRequest(port, 'GET', `/b/${pngSrc}`)).status, 401);
  });

  await check('a Send carrying close to the 20 MB limit of images lands: the submit body cap fits them', async () => {
    const { boardId: id } = await postBoard(port, SECRET, { title: 'Big but allowed', blocks: [QUESTION] });
    const big = pngOfSize(Math.floor(MAX_SEND_IMAGE_BYTES / 2) - 1);
    const other = Buffer.from(big); other[100] = 1;
    const r = await submit(id, { round: 1, answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '', images: [dataUrl('png', big), dataUrl('png', other)] }] });
    assert.equal(r.status, 200, await r.text());
    assert.equal(readdirSync(imagesDir(id)).length, 2);
  });

  await check('a file that is not a real image of its type, or over a size limit, is refused 400 naming why, and nothing is kept', async () => {
    const cases = [
      ['a .png holding text', [dataUrl('png', Buffer.from('just some text, not an image'))], /is not a real PNG image/],
      ['a GIF labelled as a JPEG', [dataUrl('jpeg', GIF)], /is not a real JPEG image/],
      ['an SVG', ['data:image/svg+xml;base64,PHN2Zy8+'], /is not a PNG, JPEG, GIF or WebP data URL/],
      ['an images field that is not a list', dataUrl('png', PNG), /"images" must be an array of image data URLs/],
      ['one image of 11 MB', [dataUrl('png', pngOfSize(11 * 1024 * 1024))], /is 11 MB, over the 10 MB limit for one image/],
      ['three images of 7 MB', [1, 2, 3].map(() => dataUrl('png', pngOfSize(7 * 1024 * 1024))), /over 20 MB, the limit for one Send/],
    ];
    assert.ok(11 * 1024 * 1024 > MAX_IMAGE_BYTES && 7 * 1024 * 1024 <= MAX_IMAGE_BYTES, 'setup: the sizes straddle the limits');
    for (const [what, images, message] of cases) {
      const { boardId: id } = await postBoard(port, SECRET, { title: what, blocks: [QUESTION] });
      const r = await submit(id, { round: 1, answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'typed', images }] });
      assert.equal(r.status, 400, `${what}: ${r.status}`);
      assert.match((await r.json()).error, message, what);
      assert.equal(readBoard(id, home).rounds[0].status, 'open', `${what}: the round stays open`);
      assert.equal(existsSync(imagesDir(id)), false, `${what}: no image is kept`);
    }
  });

  await check('deleting a board removes its images; a prune removes an old board\'s and leaves a newer one\'s', async () => {
    const make = async title => {
      const { boardId: id } = await postBoard(port, SECRET, { title, blocks: [QUESTION] });
      const r = await submit(id, { round: 1, answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '', images: [dataUrl('png', PNG)] }] });
      assert.equal(r.status, 200, await r.text());
      assert.ok(existsSync(imagesDir(id)), 'setup: the board has an image folder');
      return id;
    };
    const deleted = await make('Deleted');
    deleteBoard(deleted, home);
    assert.equal(existsSync(imagesDir(deleted)), false);

    const old = await make('Old');
    const file = path.join(boardsDir, `${old}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.createdAt = doc.updatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify(doc));
    const pruned = pruneStore(30, home);
    assert.ok(pruned.boards.includes(old));
    assert.equal(existsSync(imagesDir(old)), false);
    assert.ok(existsSync(pngPath), 'a surviving board keeps its images through the prune');
  });
}

runMain('images', main, {
  cleanup: async () => {
    if (shim) shim.close();
    if (server) await new Promise(r => server.close(r));
  },
});
