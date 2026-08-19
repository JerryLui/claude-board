// Service-level check for pruning the store by hand (ADR 71): "a prune removes both the
// document and the emitted page of every board older than the window given, and leaves
// every board newer than it untouched" (AC 12); "a prune also removes any shared script
// or stylesheet that no surviving page still references, and removes none that one does"
// (AC 13); "a prune is the only thing that ever deletes a board: nothing on read, nothing
// at daemon start, nothing scheduled" (AC 16); "after a prune, the index and archive
// search both succeed and list only surviving boards" (AC 17); "a running session whose
// board was pruned carries on: its next post lands on a fresh board rather than failing"
// (AC 18).
//
// Real daemon on an ephemeral port against its own temp store, real store code, real
// routes, no browser and no network beyond loopback -- patterned on test/check-assets.mjs
// for the daemon harness and on test/check-mcp.mjs for the scripted stdio shim AC 18
// needs (a session's board id lives in that process's memory and nowhere else, so
// nothing short of a real shim can be the session whose board went).
//
// The panel that FIRES a prune is checked where the rest of the index markup is
// (test/check-pure.mjs: one click, the window it posts, the refusal when none is named).
// This file is only ever about what a prune does to the files on disk.
//
// Every assertion here reads the store directory itself rather than asking the daemon
// what it thinks survived. A prune that answered `{ boards: 3 }` while deleting nothing
// would satisfy any check built on the response body, and deleting the wrong file is the
// entire failure mode worth defending against.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { sharedAssets, assetsNamedBy, SCRIPT_ASSET, STYLE_ASSET, MERMAID_ASSET, ASSET_NAME } from '../src/assets.mjs';
import { writeSharedAssets } from '../src/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const mcpBin = path.join(repoRoot, 'bin', 'mcp.mjs');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-prune-'));
process.env.CLAUDE_BOARD_HOME = home;
const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'd'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

// Every request here holds the secret, exactly as test/check-http.mjs's own shadowed
// `fetch` does: nothing in this file is about the credential.
const rawFetch = globalThis.fetch;
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { [SECRET_HEADER]: SECRET, ...(init.headers || {}) } });
}

const DAY = 24 * 60 * 60 * 1000;
const boardsDir = path.join(home, 'boards');
const pagesDir = path.join(home, 'pages');
const boardPath = id => path.join(boardsDir, `${id}.json`);
const pagePath = id => path.join(pagesDir, `${id}.html`);

/** Every file the store holds, both directories, sorted — the thing an assertion about
 * deletion has to be made against. */
function storeSnapshot() {
  const ls = dir => (existsSync(dir) ? readdirSync(dir).sort() : []);
  return { boards: ls(boardsDir), pages: ls(pagesDir) };
}

/** Move a board's clock back, by rewriting the file directly rather than through any
 * route: no HTTP surface can age a board, and a check that slept for the window it means
 * to test would take days. Both stamps, so this fixes the board's age regardless of which
 * one `pruneStore` reads. */
function ageBoard(id, days) {
  const board = JSON.parse(readFileSync(boardPath(id), 'utf8'));
  const iso = new Date(Date.now() - days * DAY).toISOString();
  board.createdAt = iso;
  board.updatedAt = iso;
  writeFileSync(boardPath(id), JSON.stringify(board, null, 2));
}

/** Rewrite a board's stamps by hand, to whatever shape a hand-edited or foreign-version
 * file might carry — including absent. */
function restampBoard(id, patch) {
  const board = JSON.parse(readFileSync(boardPath(id), 'utf8'));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete board[k];
    else board[k] = v;
  }
  writeFileSync(boardPath(id), JSON.stringify(board, null, 2));
}

let server, port, base;

async function prune(body) {
  const r = await fetch(`${base}/api/store/prune`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

const QUESTION = { kind: 'question', prompt: 'Proceed?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  const post = async (title, blocks, extra = {}) => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, blocks, ...extra }),
    });
    assert.equal(r.status, 200, `setup failure: posting "${title}" answered ${r.status}`);
    return await r.json();
  };

  // --- AC 12: the window decides, and only the window ----------------------------

  await check('AC 12: a prune removes the document AND the page of every board older than the window, and touches nothing newer', async () => {
    const ancient = (await post('Ancient', [{ kind: 'markdown', text: '# forty days back' }])).boardId;
    const middling = (await post('Middling', [{ kind: 'markdown', text: '# ten days back' }])).boardId;
    const fresh = (await post('Fresh', [{ kind: 'markdown', text: '# today' }])).boardId;
    ageBoard(ancient, 40);
    ageBoard(middling, 10);

    // The survivors' bytes, captured before the prune: "untouched" means untouched, not
    // merely still present.
    const middlingPage = readFileSync(pagePath(middling), 'utf8');
    const freshPage = readFileSync(pagePath(fresh), 'utf8');

    const res = await prune({ days: 30 });
    assert.equal(res.status, 200, `prune answered ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.boards, 1, 'exactly one board was older than 30 days');

    assert.equal(existsSync(boardPath(ancient)), false, 'the old board document must be gone');
    assert.equal(existsSync(pagePath(ancient)), false, 'and its emitted page with it -- a page whose board is gone is unreachable and unopenable');
    assert.equal(existsSync(boardPath(middling)), true, 'a board inside the window must survive');
    assert.equal(existsSync(boardPath(fresh)), true);
    assert.equal(readFileSync(pagePath(middling), 'utf8'), middlingPage, 'a surviving page must not be rewritten either');
    assert.equal(readFileSync(pagePath(fresh), 'utf8'), freshPage);
  });

  await check('AC 12: the age rule is flat -- a board holding a question nobody ever answered goes exactly like any other', async () => {
    const unanswered = (await post('Never answered', [QUESTION])).boardId;
    ageBoard(unanswered, 90);
    const board = JSON.parse(readFileSync(boardPath(unanswered), 'utf8'));
    assert.equal(board.rounds[0].status, 'open', 'setup failure: the round must still be open');

    const res = await prune({ days: 60 });
    assert.equal(res.status, 200);
    assert.equal(existsSync(boardPath(unanswered)), false,
      'no exemption for an open round: the rule is age alone, and it is safe to be that blunt only because nothing but a person fires it');
  });

  await check('AC 12: a board that will not state its age is KEPT, however wide the window -- deleting removes only what it can prove', async () => {
    const stampless = (await post('No stamps at all', [{ kind: 'markdown', text: '# hand-edited' }])).boardId;
    const createdOnly = (await post('createdAt only', [{ kind: 'markdown', text: '# older shape' }])).boardId;
    ageBoard(createdOnly, 50);
    restampBoard(stampless, { createdAt: undefined, updatedAt: undefined });
    restampBoard(createdOnly, { updatedAt: undefined });

    const res = await prune({ days: 1 });
    assert.equal(res.status, 200);
    assert.equal(existsSync(boardPath(stampless)), true,
      'a board with neither stamp has not been SHOWN to be older than the window, so a prune must leave it -- the opposite of how src/indexpage.mjs sorts an absent stamp, deliberately');
    assert.equal(existsSync(boardPath(createdOnly)), false,
      'but createdAt alone is a stated age, and an old one is pruned on it');
    // Left behind on purpose, so the next check's snapshot has something in it that no
    // window can ever remove.
  });

  await check('AC 12: a board whose stored id disagrees with its filename is left alone, and takes no OTHER board down with it', async () => {
    // The hazard this pins: `deleteBoard` builds both paths from one id, so pruning a
    // mismatched file on its STORED id would unlink a different board's document and
    // page entirely. The victim here is deliberately fresh -- it must survive.
    const victim = (await post('Innocent bystander', [{ kind: 'markdown', text: '# not yours to delete' }])).boardId;
    const mismatchedName = 'b_mismatch00000000000000000000000';
    const impostor = JSON.parse(readFileSync(boardPath(victim), 'utf8'));
    const iso = new Date(Date.now() - 90 * DAY).toISOString();
    impostor.createdAt = iso;
    impostor.updatedAt = iso;
    writeFileSync(boardPath(mismatchedName), JSON.stringify(impostor, null, 2));

    const res = await prune({ days: 30 });
    assert.equal(res.status, 200);
    assert.equal(existsSync(boardPath(victim)), true, 'a fresh board must never be deleted because some OTHER file claims its id');
    assert.equal(existsSync(pagePath(victim)), true, 'nor may its page be');
    assert.equal(existsSync(boardPath(mismatchedName)), true, 'and the mismatched file itself is left alone rather than guessed at');
    rmSync(boardPath(mismatchedName));
  });

  await check('AC 12: an unparseable board file is never deleted either -- a prune only ever removes a board it could read', async () => {
    const corrupt = path.join(boardsDir, 'b_corrupt0000000000000000000000.json');
    writeFileSync(corrupt, '{ this is not json');
    const res = await prune({ days: 1 });
    assert.equal(res.status, 200);
    assert.equal(existsSync(corrupt), true, 'listBoards skips it with a warning, so a prune never sees it and can never delete it');
    rmSync(corrupt);
  });

  // --- the window has no default (ADR 71) ----------------------------------------

  await check('the window has no default: a prune that does not name one is refused, not filled in', async () => {
    const before = storeSnapshot();
    for (const body of [{}, { days: null }, { days: '30' }, { days: 0 }, { days: -5 }, { days: NaN }]) {
      const res = await prune(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused, got ${res.status}`);
      assert.match(res.body.error, /days/i, 'and the refusal must say what is missing');
    }
    assert.deepEqual(storeSnapshot(), before, 'a refused prune must delete nothing at all');
  });

  // --- AC 13: the shared assets ---------------------------------------------------

  await check('AC 13: a prune removes a shared asset no surviving page names, and removes none that a survivor does', async () => {
    // A page written against an OLDER payload, exactly as a real store accumulates them:
    // the assets go down under their own content-addressed names (through the real
    // never-overwrite writer), and a real board's page is rewritten to name them.
    const stale = sharedAssets('/* an older client script */', '/* an older stylesheet */');
    writeSharedAssets(home, stale);
    const staleNames = stale.map(a => a.name);
    for (const name of staleNames) {
      assert.equal(existsSync(path.join(pagesDir, name)), true, `setup failure: ${name} was not written`);
      assert.ok(ASSET_NAME.test(name), `setup failure: ${name} is not an asset name`);
    }

    const old = (await post('Written against the old payload', [{ kind: 'markdown', text: '# old' }])).boardId;
    const survivor = (await post('Written against the current payload', [{ kind: 'markdown', text: '# new' }])).boardId;
    writeFileSync(pagePath(old), `<!doctype html><html><head><link rel="stylesheet" href="${staleNames[1]}"></head><body><script src="${staleNames[0]}" defer></script></body></html>`);
    ageBoard(old, 40);

    // The precondition the whole check rests on: before the prune, BOTH generations are
    // referenced by a page that exists.
    assert.deepEqual(assetsNamedBy(readFileSync(pagePath(old), 'utf8')).sort(), [...staleNames].sort());
    assert.deepEqual(assetsNamedBy(readFileSync(pagePath(survivor), 'utf8')).filter(n => n === SCRIPT_ASSET || n === STYLE_ASSET).sort(),
      [SCRIPT_ASSET, STYLE_ASSET].sort(), 'setup failure: the surviving page does not name the current assets');

    const res = await prune({ days: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.body.assets, 2, 'both halves of the orphaned generation must be reported gone');

    for (const name of staleNames) {
      assert.equal(existsSync(path.join(pagesDir, name)), false,
        `${name} is named by no surviving page, so a prune must reclaim it -- this is the only thing that ever reclaims one`);
    }
    for (const name of [SCRIPT_ASSET, STYLE_ASSET]) {
      assert.equal(existsSync(path.join(pagesDir, name)), true,
        `${name} is still named by a surviving page, so a prune must never remove it`);
    }
  });

  await check('AC 13: the survivor still loads -- the assets its own bytes name are all still served', async () => {
    const survivor = (await post('Loads after a prune', [{ kind: 'markdown', text: '# still here' }])).boardId;
    await prune({ days: 30 });
    const page = readFileSync(pagePath(survivor), 'utf8');
    const named = assetsNamedBy(page).filter(n => n === SCRIPT_ASSET || n === STYLE_ASSET);
    assert.ok(named.length >= 2, 'setup failure: the page names neither shared asset');
    for (const name of named) {
      // Resolved the way a browser resolves a bare sibling filename on a page served at
      // /b/<id>, not hand-built -- the same discipline test/check-assets.mjs applies.
      const r = await fetch(new URL(name, `${base}/b/${survivor}`));
      assert.equal(r.status, 200, `${name} must still be served after a prune`);
    }
  });

  await check('AC 13: mermaid survives a prune through an ORDINARY page, even though no page names it directly -- the sweep must follow the transitive reference via ui.js', async () => {
    // An ordinary board, through the real daemon -- writePage (src/store.mjs) writes
    // mermaid alongside ui.js/styles.css for every page (SHARED_ASSETS, src/assets.mjs),
    // whether or not this particular board carries a mermaid block at all.
    const survivor = (await post('Names mermaid only transitively', [{ kind: 'markdown', text: '# still here' }])).boardId;
    assert.equal(existsSync(path.join(pagesDir, MERMAID_ASSET)), true,
      'setup failure: the vendored engine must already be on disk, written alongside every page');
    assert.deepEqual(assetsNamedBy(readFileSync(pagePath(survivor), 'utf8')).filter(n => n === MERMAID_ASSET), [],
      'setup failure: an ORDINARY page must not name mermaid directly -- it is loaded only from inside ui.js, on demand (src/ui.mjs), never from a page\'s own markup');
    assert.ok(assetsNamedBy(readFileSync(path.join(pagesDir, SCRIPT_ASSET), 'utf8')).includes(MERMAID_ASSET),
      'setup failure: the CURRENT ui.js asset must itself name mermaid (src/ui.mjs splices MERMAID_ASSET into its own bytes) -- this is the transitive link a prune has to follow');

    // A window nothing on disk is older than: no board goes, so this isolates the sweep
    // half exactly like the orphan check below does.
    const res = await prune({ days: 3650 });
    assert.equal(res.status, 200);
    assert.equal(res.body.boards, 0, 'setup failure: this prune must remove no board');
    assert.equal(existsSync(path.join(pagesDir, MERMAID_ASSET)), true,
      'mermaid must survive the sweep even though no page names it directly -- src/store.mjs\'s sweepUnreferencedAssets has to scan every surviving ASSET\'s bytes too, not just every page\'s, or this is exactly the file it would wrongly reclaim');
  });

  await check('AC 13: a board whose only mermaid is an html STAGE names the engine in its own bytes, keeps it beside the page, and keeps it across a prune', async () => {
    // The stage case is the one where a page's own markup DOES name the engine: the
    // srcdoc of a diagram-bearing stage carries the bare filename, HTML-escaped into an
    // attribute but byte-for-byte intact, which is exactly what `assetsNamedBy`'s scan is
    // built to find. That is what makes such an archive self-describing -- the folder a
    // reader mails around says, in the page's own bytes, which sibling it needs.
    const stage = { kind: 'html', html: '<div class="doc"><pre class="mermaid">flowchart LR\n  A --> B</pre></div>' };
    const boardId = (await post('A diagram inside a stage', [stage, { kind: 'markdown', text: 'not a page board' }])).boardId;
    const page = readFileSync(pagePath(boardId), 'utf8');
    assert.ok(assetsNamedBy(page).includes(MERMAID_ASSET),
      'a stage-diagram page must name the engine in its OWN bytes -- the escaped srcdoc carries the bare filename');
    assert.equal(existsSync(path.join(pagesDir, MERMAID_ASSET)), true,
      'and the engine must be on disk beside the page, or the archive opens from Finder with nothing to render the diagram with');
    // Resolved the way a browser resolves a bare sibling filename on a page served at
    // /b/<id>, never hand-built.
    const served = await fetch(new URL(MERMAID_ASSET, `${base}/b/${boardId}`));
    assert.equal(served.status, 200, 'and the same name must resolve served');

    const res = await prune({ days: 3650 });
    assert.equal(res.status, 200);
    assert.equal(res.body.boards, 0, 'setup failure: this prune must remove no board');
    assert.equal(existsSync(path.join(pagesDir, MERMAID_ASSET)), true, 'the engine a stage names must survive the sweep');
  });

  await check('AC 13: an asset no page has EVER named is reclaimed too -- the sweep is about references, not about which board went', async () => {
    const orphan = sharedAssets('/* named by nothing at all */', '/* nor this */');
    writeSharedAssets(home, orphan);
    for (const a of orphan) assert.equal(existsSync(path.join(pagesDir, a.name)), true, 'setup failure');
    // A window nothing on disk is older than: no board goes, and the sweep still runs.
    const res = await prune({ days: 3650 });
    assert.equal(res.status, 200);
    assert.equal(res.body.boards, 0, 'setup failure: this prune was meant to remove no board');
    for (const a of orphan) assert.equal(existsSync(path.join(pagesDir, a.name)), false, `${a.name} is named by nothing and must go`);
    for (const name of [SCRIPT_ASSET, STYLE_ASSET]) {
      assert.equal(existsSync(path.join(pagesDir, name)), true, `${name} is still named by a live page`);
    }
  });

  await check('a sweep failure after boards are already gone still reports how many were removed, not a bare fs error', async () => {
    // sweepUnreferencedAssets (src/store.mjs) reads every surviving ASSET's bytes too, not
    // just every page's (the mermaid transitive-reference test above) -- so an asset-named
    // entry that cannot be read as UTF8 text throws there. A directory is the deterministic
    // way to hit that: readdirSync lists it, ASSET_NAME matches its name, and readFileSync
    // on a directory throws EISDIR, never ENOENT, so the sweep's read loop rethrows it.
    const doomed = (await post('Gone before the sweep trips', [{ kind: 'markdown', text: '# aged out' }])).boardId;
    ageBoard(doomed, 40);
    const trap = path.join(pagesDir, 'mermaid-1111111111111111.js');
    mkdirSync(trap);
    try {
      const res = await prune({ days: 30 });
      assert.equal(res.status, 500, `a sweep failure must still answer -- got ${res.status}: ${JSON.stringify(res.body)}`);
      // The board above is unlinked, for real, before the sweep ever runs (pruneStore's own
      // ordering comment) -- that destructive step already succeeded and must not vanish
      // from the response just because the step after it failed.
      assert.equal(existsSync(boardPath(doomed)), false, 'the aged board must actually be gone, sweep failure or not');
      assert.match(res.body.error, /deleted 1 board/, `the error must name how many boards this call already removed, got: ${res.body.error}`);
      assert.match(res.body.error, /EISDIR|illegal operation/i, `and still carry the underlying fs failure, got: ${res.body.error}`);
    } finally {
      rmSync(trap, { recursive: true, force: true }); // or every later prune in this file trips the same trap
    }
  });

  // --- AC 17: the index and archive search after a prune ---------------------------

  await check('AC 17: after a prune the index and archive search both succeed, and list only survivors', async () => {
    // The searchable term goes in a question PROMPT: archive search walks what was asked
    // and what was answered (src/store.mjs searchBoards), never a markdown body.
    const zardoz = { ...QUESTION, prompt: 'Does ZARDOZ approve?' };
    const goner = (await post('Prunable session', [zardoz])).boardId;
    const keeper = (await post('Surviving session', [zardoz])).boardId;
    ageBoard(goner, 40);

    // Both are on the index and in the search before the prune, or afterwards proves
    // nothing about either.
    const beforeIndex = await (await fetch(`${base}/`)).text();
    assert.ok(beforeIndex.includes('Prunable session') && beforeIndex.includes('Surviving session'), 'setup failure: both rows must be on the index first');
    const beforeSearch = await (await fetch(`${base}/api/search?q=ZARDOZ`)).json();
    assert.ok(beforeSearch.results.some(r => r.boardId === goner) && beforeSearch.results.some(r => r.boardId === keeper), 'setup failure: both boards must match first');

    assert.equal((await prune({ days: 30 })).status, 200);

    const indexRes = await fetch(`${base}/`);
    assert.equal(indexRes.status, 200, 'the index must still render -- a walk over a store a prune just changed is the case this is about');
    const index = await indexRes.text();
    assert.ok(index.includes('Surviving session'), 'the surviving thread must still be listed');
    assert.ok(!index.includes('Prunable session'), 'the pruned thread must be gone from the index, not left as a row linking to a 404');

    const searchRes = await fetch(`${base}/api/search?q=ZARDOZ`);
    assert.equal(searchRes.status, 200, 'archive search must still succeed');
    const { results } = await searchRes.json();
    assert.ok(results.length > 0, 'and still find the surviving board');
    assert.ok(results.every(r => r.boardId !== goner), 'no result may point at a board that no longer exists');
    assert.ok(results.some(r => r.boardId === keeper));

    assert.equal((await fetch(`${base}/b/${goner}`)).status, 404, 'and the pruned board itself is simply not there');
    assert.equal((await fetch(`${base}/b/${keeper}`)).status, 200);
  });

  // --- AC 16: a prune is the ONLY thing that ever deletes a board -------------------

  await check('AC 16: reading changes nothing -- the index, a board page, archive search and a wait all leave every file where it was', async () => {
    // Deliberately ancient, and never pruned: if anything anywhere applied an implicit
    // window, this is the board it would take.
    const ancient = (await post('Read but never pruned', [{ kind: 'markdown', text: '# five years old' }])).boardId;
    ageBoard(ancient, 5 * 365);
    const before = storeSnapshot();
    assert.ok(before.boards.includes(`${ancient}.json`), 'setup failure');

    await fetch(`${base}/`);
    await fetch(`${base}/?q=Read`);
    await fetch(`${base}/b/${ancient}`);
    await fetch(`${base}/api/search?q=five`);
    await fetch(`${base}/api/pomodoro`);
    // `/wait` reads the board before it decides anything, and a round number the board
    // does not have makes it answer at once instead of holding the socket open for the
    // whole 40-minute cap. The read is the part that matters here.
    assert.equal((await fetch(`${base}/api/board/${ancient}/wait?round=99`)).status, 404);

    assert.deepEqual(storeSnapshot(), before, 'no read may delete anything, at any age');
  });

  await check('AC 16: starting a daemon changes nothing -- no reap, no sweep, no expiry at boot', async () => {
    const before = storeSnapshot();
    assert.ok(before.boards.length >= 2, 'setup failure: an empty store would prove nothing');

    // A genuine second daemon against the same store, booted and shut down. Its own
    // ephemeral port, so it never collides with the one this file already runs.
    const second = await startServer({ home, port: 0 });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${second.port}/`)).status, 200, 'setup failure: the second daemon never came up');
      assert.deepEqual(storeSnapshot(), before, 'a daemon start must delete nothing');
    } finally {
      await new Promise(resolve => second.server.close(resolve));
    }
    assert.deepEqual(storeSnapshot(), before, 'and neither must a daemon shutdown');
  });

  await check('AC 16: nothing in the source can delete a board except the prune, and nothing schedules it', async () => {
    const files = [];
    for (const dir of ['src', 'bin']) {
      for (const f of readdirSync(path.join(repoRoot, dir)).filter(n => n.endsWith('.mjs'))) {
        files.push({ rel: `${dir}/${f}`, text: readFileSync(path.join(repoRoot, dir, f), 'utf8') });
      }
    }
    assert.ok(files.length > 10, 'setup failure: found almost no source files to scan');

    // CALL sites, not mentions: `\bname\s*\(` never matches the prose in a comment, which
    // is free to discuss either function as much as it likes.
    const callers = re => files.filter(f => re.test(f.text)).map(f => f.rel).sort();
    assert.deepEqual(callers(/\bdeleteBoard\s*\(/), ['src/store.mjs'],
      'deleteBoard must have exactly one caller, pruneStore, in the module that defines it -- a second one anywhere is a second way to lose a board');
    assert.deepEqual(callers(/\bpruneStore\s*\(/), ['src/server.mjs', 'src/store.mjs'],
      'pruneStore must be called from exactly one place outside its own module: the route');

    const serverSrc = files.find(f => f.rel === 'src/server.mjs').text;
    assert.equal((serverSrc.match(/\bpruneStore\s*\(/g) || []).length, 1, 'and exactly once there');

    // Nothing scheduled, in any file: no timer, interval or delayed callback anywhere
    // mentions a prune. This is the assertion the decision "nothing sweeps" actually
    // needs -- the two above would still pass against a daemon that pruned on a timer.
    for (const f of files) {
      assert.doesNotMatch(f.text, /set(?:Interval|Timeout)\s*\([^)]*[Pp]rune/,
        `${f.rel} appears to schedule a prune -- nothing sweeps: not on read, not at daemon start, not on a timer`);
    }
  });

  // --- AC 18: a running session whose board was pruned -----------------------------

  await check('AC 18: a session whose board was pruned mid-run carries on -- its next post lands on a fresh board rather than failing', async () => {
    const shim = spawn(process.execPath, [mcpBin], {
      env: {
        ...process.env,
        CLAUDE_BOARD_HOME: home,
        CLAUDE_BOARD_PORT: String(port),
        CLAUDE_BOARD_NO_OPEN: '1', // stand-in for `open`: no real browser, ever
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buf = '';
    let nextId = 1;
    shim.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000).unref();
      shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-prune', version: '0' } });

      // Content-only, so the call returns the instant the post lands and never blocks on
      // a reviewer -- the board id it leaves in the shim's memory is all this needs.
      const first = await request('tools/call', {
        name: 'ask',
        arguments: { title: 'Session that outlives its board', blocks: [{ kind: 'markdown', text: '# round one' }] },
      });
      assert.equal(first.result.isError, false, `setup failure: first ask errored: ${JSON.stringify(first.result)}`);
      const firstBoard = first.result.board;
      assert.ok(firstBoard, 'setup failure: no board id came back');

      // The reviewer prunes from the settings panel while the session is still running.
      ageBoard(firstBoard, 40);
      assert.equal((await prune({ days: 30 })).status, 200);
      assert.equal(existsSync(boardPath(firstBoard)), false, 'setup failure: the session\'s board was not actually pruned');

      const second = await request('tools/call', {
        name: 'ask',
        arguments: { title: 'Session that outlives its board', blocks: [{ kind: 'markdown', text: '# round two' }] },
      });
      assert.equal(second.result.isError, false,
        `a post into a pruned board must mint a fresh one, not fail: ${JSON.stringify(second.result)}`);
      const secondBoard = second.result.board;
      assert.notEqual(secondBoard, firstBoard, 'and it must be a NEW board, not the dead id handed back');
      assert.equal(existsSync(boardPath(secondBoard)), true, 'the fresh board must actually be in the store');
      assert.equal(existsSync(pagePath(secondBoard)), true, 'with its page');
      assert.equal(second.result.round, 1, 'a fresh board starts at round 1');

      // And the session keeps working from there: the round after that pushes into the
      // board it just minted rather than minting a third.
      const third = await request('tools/call', {
        name: 'ask',
        arguments: { title: 'Session that outlives its board', blocks: [{ kind: 'markdown', text: '# round three' }] },
      });
      assert.equal(third.result.isError, false);
      assert.equal(third.result.board, secondBoard, 'the session must settle onto the fresh board, not re-mint on every call');
    } finally {
      try { shim.stdin.end(); } catch { /* already closed */ }
      try { shim.kill(); } catch { /* already dead */ }
    }
  });
}

try {
  await main();
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} prune check(s) failed`);
  process.exit(1);
}
console.log('\nall prune checks ok');
