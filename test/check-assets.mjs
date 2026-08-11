// Service-level check for the shared, content-addressed assets (ADR 70): "a newly
// written page references the shared script and stylesheet instead of inlining them, and
// weighs correspondingly less" (AC 8); "a board page opened straight from Finder, with
// the daemon stopped, still renders and behaves exactly as it does when served" (AC 9);
// "a page already on disk before this change is never rewritten, and still opens
// correctly from Finder afterwards" (AC 10); "changing the shared script does not alter
// any page already written: an old page keeps loading the exact bytes it was written
// against" (AC 11).
//
// Real daemon on an ephemeral port against its own temp store, real store code, no
// browser and no network beyond loopback -- patterned on test/check-attended.mjs for the
// daemon harness and on test/check-archive.mjs for the Finder surface (the DOM stand-in,
// with `location.protocol` genuinely `'file:'`).
//
// The one thing this file is careful never to do is assert against payloads it imported.
// A check that reads the page, then runs the `ui` string it happens to have in memory,
// passes just as happily against a page whose reference points at nothing -- which is the
// entire failure mode ADR 70 introduces. So every load below takes the bare filename out
// of the page's OWN bytes, resolves it the way the surface under test would (relative to
// the archive's directory for Finder; relative to `/b/<id>` for the daemon), and reads
// what is actually there.
//
// "Changing the shared payload" is exercised through `sharedAssets(scriptText, styleText)`
// and `writeSharedAssets(home, assets)` -- the real naming and the real never-overwrite
// write -- rather than by editing src/ui.mjs mid-run, which is why both take an argument.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { readBoard, writeSharedAssets } from '../src/store.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { sharedAssets, assetsNamedBy, SCRIPT_ASSET, STYLE_ASSET, MERMAID_ASSET, ASSET_NAME } from '../src/assets.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML } from './dom-stand-in.mjs';

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

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-assets-'));
process.env.CLAUDE_BOARD_HOME = home;
const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'c'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

// Every request here holds the secret, exactly as test/check-http.mjs's own shadowed
// `fetch` does: nothing in this file is about the credential.
const rawFetch = globalThis.fetch;
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { [SECRET_HEADER]: SECRET, ...(init.headers || {}) } });
}

const pagesDir = path.join(home, 'pages');
const pagePath = id => path.join(pagesDir, `${id}.html`);

/** The bare sibling filenames a page's own bytes name, as the two surfaces see them.
 * Deliberately the tag-attribute reading rather than `assetsNamedBy` -- a scan for the
 * NAME shape would find one inside the inlined `#board-data` JSON just as happily, and
 * what has to be proven here is that a browser fetching an attribute finds it. */
function referencesIn(pageText) {
  const refs = [];
  for (const [, tag, attrs] of pageText.matchAll(/<(link|script|img|iframe)\b([^>]*)>/g)) {
    const m = attrs.match(/\s(?:src|href)="([^"]*)"/);
    if (m && !m[1].startsWith('data:')) refs.push({ tag, ref: m[1] });
  }
  return refs;
}

/** Open a page the way Finder does: its bytes off disk, the script it NAMES read from
 * beside it, `location.protocol` genuinely `'file:'`, and nothing to talk to. Returns the
 * hydrated document; the caller restores the globals. */
function openFromFinder(diskPath, scriptText) {
  const html = readFileSync(diskPath, 'utf8');
  const document = parseHTML(html);
  const window = document.defaultView;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a page opened from Finder must never call fetch'); };
  // 'EventSource' is DECLARED and handed a throwing class as its own argument --
  // never assigned to globalThis -- so the assertion this proves is stronger, not
  // weaker: the page's script can no longer resolve the name past this harness at
  // all, rather than merely finding nothing left on globalThis to construct.
  const ThrowingEventSource = class {
    constructor() { throw new Error('a page opened from Finder must never open an EventSource'); }
  };
  try {
    new Function('document', 'window', 'location', 'EventSource', scriptText)(document, window, { protocol: 'file:' }, ThrowingEventSource);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return document;
}

let server, port, base;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  const post = async (title, blocks) => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, blocks }),
    });
    assert.equal(r.status, 200, `setup failure: posting "${title}" answered ${r.status}`);
    return (await r.json()).boardId;
  };

  const boardId = await post('Shared assets', [
    { kind: 'markdown', text: '# Notes\n\n- alpha\n- beta' },
    { kind: 'question', prompt: 'Proceed?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]);
  const page = readFileSync(pagePath(boardId), 'utf8');

  // --- AC 8: names them, does not carry them, and weighs correspondingly less -----

  await check('AC 8: a newly written page names the shared script and stylesheet instead of carrying them', () => {
    assert.ok(!page.includes(ui), 'the page still carries the client script');
    assert.ok(!page.includes(styles), 'the page still carries the stylesheet');
    const refs = referencesIn(page).map(r => r.ref);
    assert.deepEqual(refs.sort(), [SCRIPT_ASSET, STYLE_ASSET].sort(),
      `the page must load exactly the two shared assets and nothing else, got ${JSON.stringify(refs)}`);
    for (const ref of refs) {
      assert.ok(ASSET_NAME.test(ref) && !ref.includes('/') && !ref.includes(':') && !ref.startsWith('.'),
        `"${ref}" is not a bare content-addressed sibling filename -- the one form that resolves from both surfaces`);
    }
  });

  await check('AC 8: and weighs correspondingly less -- the payloads are the bulk of what a page used to be', () => {
    const pageBytes = Buffer.byteLength(page);
    const payloadBytes = Buffer.byteLength(ui) + Buffer.byteLength(styles);
    // What this page would have weighed before ADR 70, near enough: its own markup plus
    // one private copy of each payload. Asserted as a RATIO rather than an absolute
    // ceiling, so it stays true as the board fixture or the payloads grow.
    assert.ok(pageBytes * 4 < pageBytes + payloadBytes,
      `a page must now weigh under a quarter of its inlined self: ${pageBytes} bytes vs ${pageBytes + payloadBytes}`);
    assert.ok(payloadBytes > 400_000, `setup failure: the shared payloads are only ${payloadBytes} bytes, so this check proves nothing`);
  });

  // --- AC 9 (half one): both surfaces resolve the same reference to the same bytes -

  await check('both surfaces resolve the same reference: the served page and the file on disk name the same assets', async () => {
    const served = await (await fetch(`${base}/b/${boardId}`)).text();
    assert.equal(served, page, 'the served page and the pages/ file must still be the same bytes');
    assert.deepEqual(referencesIn(served), referencesIn(page));
  });

  await check('the daemon serves each named asset from disk, byte-identical to the sibling a Finder reader would open', async () => {
    for (const { ref } of referencesIn(page)) {
      // Resolved, not hand-built: this is the browser's own relative-URL resolution
      // applied to the page's real URL, which is what proves a bare filename on a page
      // served at /b/<id> is a request for /b/<name> and not for /<name>.
      const resolved = new URL(ref, `${base}/b/${boardId}`);
      const r = await fetch(resolved);
      assert.equal(r.status, 200, `GET ${resolved.pathname} answered ${r.status}`);
      assert.equal(r.headers.get('content-type'), ref.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      const servedBytes = Buffer.from(await r.arrayBuffer());
      const onDisk = readFileSync(path.join(pagesDir, ref));
      assert.ok(servedBytes.equals(onDisk), `${ref} served over HTTP differs from the sibling file on disk`);
      assert.equal(onDisk.toString('utf8'), ref.endsWith('.css') ? styles : ui, `${ref} is not the real shared payload`);
    }
  });

  await check('a well-formed asset name this store has never written is a 404, not a leak or a crash', async () => {
    const r = await fetch(`${base}/b/ui-0000000000000000.js`);
    assert.equal(r.status, 404);
  });

  // --- AC 9 (half two): the page opens from Finder, from its own folder -----------

  await check('AC 9: the page opens straight from Finder -- its named siblings resolve against its own directory and really run', () => {
    const named = referencesIn(page);
    const scriptRef = named.find(r => r.ref.endsWith('.js')).ref;
    const styleRef = named.find(r => r.ref.endsWith('.css')).ref;
    // Resolved against the ARCHIVE's directory, which is all a `file:` URL gives you.
    const scriptText = readFileSync(path.join(path.dirname(pagePath(boardId)), scriptRef), 'utf8');
    const cssText = readFileSync(path.join(path.dirname(pagePath(boardId)), styleRef), 'utf8');
    assert.ok(cssText.includes(':root'), 'the sibling stylesheet must be a real stylesheet');

    const document = openFromFinder(pagePath(boardId), scriptText);
    assert.equal(document.body.classList.contains('readonly'), true,
      'the script the page names must actually run and take src/ui.mjs\'s file: branch');
    assert.ok(document.querySelector('.question-block'), 'the board content must still be there');
    assert.equal(document.getElementById('send-btn').disabled, true, 'an archive invites no gesture it cannot honour');
  });

  // --- AC 11: changing the shared payload leaves an existing page on its original --

  const nextGeneration = sharedAssets(`${ui}\n/* a later version of the client script */\n`, `${styles}\n/* a later version */\n`);

  await check('AC 11: a changed payload mints new names rather than reusing the old ones', () => {
    const oldNames = new Set([SCRIPT_ASSET, STYLE_ASSET]);
    for (const asset of nextGeneration) {
      assert.ok(ASSET_NAME.test(asset.name), `${asset.name} is not a well-formed asset name`);
      assert.ok(!oldNames.has(asset.name), `a changed payload reused the name ${asset.name}, so an old page would silently load new bytes`);
    }
  });

  await check('AC 11: writing the new generation leaves every already-written asset exactly as it was', () => {
    const before = referencesIn(page).map(({ ref }) => [ref, readFileSync(path.join(pagesDir, ref))]);
    writeSharedAssets(home, nextGeneration);
    for (const [ref, bytes] of before) {
      assert.ok(readFileSync(path.join(pagesDir, ref)).equals(bytes), `${ref} was rewritten -- a page written against it now loads different bytes`);
    }
    for (const asset of nextGeneration) {
      assert.equal(readFileSync(path.join(pagesDir, asset.name), 'utf8'), asset.contents, `${asset.name} was not written`);
    }
  });

  await check('AC 11: the page written before the change still names its original, and the daemon still serves those exact bytes', async () => {
    assert.equal(readFileSync(pagePath(boardId), 'utf8'), page, 'the page on disk was rewritten by a payload change');
    for (const { ref } of referencesIn(page)) {
      const r = await fetch(new URL(ref, `${base}/b/${boardId}`));
      assert.equal(r.status, 200);
      assert.equal(await r.text(), ref.endsWith('.css') ? styles : ui,
        `${ref} now serves something other than the bytes the page was written against`);
    }
    // And a page written AFTER the change would name the new generation -- proving the
    // two really do coexist, which is what "never deleted or rewritten" buys.
    for (const asset of nextGeneration) {
      const r = await fetch(`${base}/b/${asset.name}`);
      assert.equal(r.status, 200, `the new generation's ${asset.name} must be servable too`);
      assert.equal(await r.text(), asset.contents);
    }
  });

  await check('an existing asset is never overwritten, whatever it is handed', () => {
    const target = path.join(pagesDir, SCRIPT_ASSET);
    const original = readFileSync(target);
    // The ablation, run for real: hand `writeSharedAssets` an asset claiming an existing
    // name with different contents. The existence guard is the only thing between that
    // and every page ever written against that name loading a corrupted script.
    writeSharedAssets(home, [{ name: SCRIPT_ASSET, contents: 'CORRUPTED' }]);
    assert.ok(readFileSync(target).equals(original), 'writeSharedAssets overwrote an asset that already existed');
  });

  // --- AC 10: a page already on disk is never rewritten, and still opens ----------

  // Stand in for a page written by a daemon that predates ADR 70: fully self-contained,
  // both payloads inlined, naming no sibling at all. Built by putting the payloads back
  // into a real render rather than hand-writing markup, so it is exactly the shape every
  // archive already on disk has -- and written straight to pages/, bypassing writePage,
  // the same way test/check-http.mjs stands in a frozen pre-theme archive.
  const legacyId = await post('Already on disk', [{ kind: 'markdown', text: '# Older\n\nwritten before the split' }]);
  const legacyPath = pagePath(legacyId);
  const legacyHtml = renderBoardPage(readBoard(legacyId, home))
    .replace(`<link rel="stylesheet" href="${STYLE_ASSET}">`, `<style>${styles}</style>`)
    .replace(`<script defer src="${SCRIPT_ASSET}"></script>`, `<script type="module">${ui}</script>`);
  writeFileSync(legacyPath, legacyHtml, 'utf8');

  await check('AC 10: setup -- the stand-in really is an old-shaped page, carrying both payloads and naming no sibling FILE', () => {
    assert.ok(legacyHtml.includes(ui) && legacyHtml.includes(styles), 'setup failure: the stand-in does not carry the payloads');
    assert.deepEqual(referencesIn(legacyHtml), [], 'setup failure: the stand-in still references something');
    // NOT an empty array any more: this page inlines the whole `ui` string
    // verbatim, and `ui` itself now names the vendored mermaid engine's bare
    // filename as a literal (src/ui.mjs's own splice, next to MERMAID_TOKEN_MAP)
    // -- assetsNamedBy over-reports by design (it scans bytes, not tags), so it
    // correctly finds that mention even though nothing here is an actual
    // `<script src>`/`<link href>` reference. `referencesIn`, just above, is
    // still the one that proves "no sibling FILE reference" -- that stays [].
    assert.deepEqual(assetsNamedBy(legacyHtml), [MERMAID_ASSET],
      'setup failure: the stand-in must name exactly the mermaid engine (transitively, via its inlined ui string) and nothing else');
  });

  await check('AC 10: a page already on disk is never rewritten -- not by a read, not by another board being posted', async () => {
    const r = await fetch(`${base}/b/${legacyId}`);
    assert.equal(r.status, 200);
    assert.notEqual(await r.text(), legacyHtml, 'setup failure: GET must re-render from JSON, so the served page cannot be the frozen bytes');
    await post('Something else entirely', [{ kind: 'markdown', text: '# unrelated' }]);
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyHtml,
      'an archive already on disk was rewritten -- this change slims only pages written from now on');
  });

  await check('AC 10: and it still opens correctly from Finder afterwards, with no sibling files at all', () => {
    // Its own inlined script, out of its own bytes -- an old archive is a single file and
    // has nothing beside it to resolve.
    const m = legacyHtml.match(/<script type="module">([\s\S]*?)<\/script>\n<\/body>/);
    assert.ok(m, 'setup failure: could not find the frozen page\'s own inlined script');
    const document = openFromFinder(legacyPath, m[1]);
    assert.equal(document.body.classList.contains('readonly'), true, 'the frozen archive must still open read-only from disk');
    assert.ok(document.querySelector('[data-block-kind="markdown"]'), 'the frozen archive must still render its content');
  });

  // --- the store's shape, for whatever prunes it later ----------------------------

  await check('pages/ holds nothing but board pages and well-formed shared assets, and "which assets does this page name?" is answerable from a page\'s bytes alone', () => {
    // Not a prune, and not a rehearsal of one -- this is the layout invariant a prune
    // will depend on, pinned here so it cannot quietly stop holding: everything in
    // `pages/` is either `<boardId>.html` or a name matching `ASSET_NAME`, and the
    // question a garbage-collector has to ask ("which assets does this page name?") is
    // answered by `assetsNamedBy` scanning bytes, with no HTML parsing.
    const referenced = new Set();
    const assetsOnDisk = new Set();
    for (const entry of readdirSync(pagesDir)) {
      if (entry.endsWith('.html')) {
        const named = assetsNamedBy(readFileSync(path.join(pagesDir, entry), 'utf8'));
        for (const name of named) referenced.add(name);
        continue;
      }
      assert.ok(ASSET_NAME.test(entry), `pages/ holds "${entry}", which is neither a board page nor a shared asset`);
      assetsOnDisk.add(entry);
    }
    for (const name of referenced) {
      assert.ok(assetsOnDisk.has(name), `a page names ${name}, which is not in pages/`);
    }
    // The three generations this run has produced: the current ui/styles pair, plus the
    // two of the next generation written above -- four files, all still there, none
    // replaced -- PLUS the one vendored mermaid engine, written once (SHARED_ASSETS'
    // never-overwrite guard, src/store.mjs) the first time any page was written in this
    // run, and never duplicated since (it has no "next generation" to simulate here --
    // see src/assets.mjs's own comment on why it sits outside sharedAssets()).
    assert.equal(assetsOnDisk.size, 5, `expected five asset files to have accumulated, found ${[...assetsOnDisk].join(', ')}`);
    // An ORDINARY board page never names mermaid directly -- it is loaded only from
    // inside ui.js, on demand (src/ui.mjs), never from a page's own markup -- so this
    // set would otherwise be just [SCRIPT_ASSET, STYLE_ASSET]. It carries MERMAID_ASSET
    // too here only because the AC 10 fixture above inlines the whole `ui` string
    // verbatim into a page, and `ui` itself names mermaid's filename as a literal (the
    // same over-report `assetsNamedBy` is designed to produce, pinned by name at AC 10's
    // own setup check). test/check-prune.mjs is where mermaid's transitive survival
    // through an ORDINARY page (naming only ui.js, which in turn names mermaid.js) is
    // pinned end to end, including a sweep that must not collect it.
    assert.deepEqual([...referenced].sort(), [SCRIPT_ASSET, STYLE_ASSET, MERMAID_ASSET].sort(),
      'only the generation the pages were written against is referenced -- the other two are exactly what a prune exists to collect');
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall shared-asset checks ok');
  });
