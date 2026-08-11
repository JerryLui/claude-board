// Board JSON persistence under CLAUDE_BOARD_HOME. See PROTOCOL.md "Paths".
//
// $CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
// $CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, standalone-openable
// $CLAUDE_BOARD_HOME/pages/ui-<hash>.js       the shared client script a page names
// $CLAUDE_BOARD_HOME/pages/styles-<hash>.css  the shared stylesheet a page names
// $CLAUDE_BOARD_HOME/pages/mermaid-<hash>.js  the shared diagram engine, named by ui.js
//                                             rather than by any page (see sweep below)
//
// The three shared assets are siblings of the page ON PURPOSE (ADR 70): a bare filename is
// the one reference that resolves the same served (`/b/<name>`) and opened from Finder
// (`./<name>`). They are content-addressed and append-only — see src/assets.mjs.
//
// Writes are atomic (temp file + rename) so a mid-write daemon restart cannot
// corrupt a board: a reader always sees either the old or the new content, never a
// partial one.

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { closeLapsedAwaitedRounds } from './badge.mjs';
import { SHARED_ASSETS, ASSET_NAME, assetsNamedBy } from './assets.mjs';
import path from 'node:path';
import os from 'node:os';

// The default moved out of ~/Documents/renders/board on 2026-07-30: the renders
// directory is one author's /visualize convention and means nothing to anyone else,
// while Application Support is where a macOS daemon's own state belongs. No migration
// is built, deliberately — there is no installed base, and a board is addressed by id
// from the index rather than by path.
export function boardHome() {
  return process.env.CLAUDE_BOARD_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'claude-board');
}

function boardsDir(home = boardHome()) {
  return path.join(home, 'boards');
}

function pagesDir(home = boardHome()) {
  return path.join(home, 'pages');
}

/** What a board id is allowed to be. Canonical here rather than in a caller because
 * THIS module is what turns an id into a filesystem path, and a pattern enforced at the
 * route is a pattern the next route forgets: `POST /api/board` used to hand
 * `body.boardId` straight to readBoard, so an id of `../../../../tmp/victim/settings`
 * read and then OVERWROTE a file outside the store. Minted ids are
 * `b_<32 hex>` (src/board.mjs); the class is wider than that so an id minted by an older
 * version still resolves, and narrow enough that no member of it contains a separator,
 * a dot, or a NUL. */
export const SAFE_BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every path built from an id goes through here. Throws rather than returning null:
 * an id that cannot be a path is a caller bug or an attack, and both deserve to be loud
 * — readBoard turns it back into a 400 for the one caller that takes ids from the wire. */
function assertSafeId(id) {
  if (typeof id !== 'string' || !SAFE_BOARD_ID.test(id)) {
    throw Object.assign(new Error(`unsafe board id: ${JSON.stringify(String(id))}`), { status: 400 });
  }
  return id;
}

// The store holds every question, answer, note and snapshotted source file from every
// session and every project, and forgets none of it on its own — nothing here expires,
// sweeps or reaps. `pruneStore` below is the only thing that ever removes a board, and
// only a person firing it by hand from the index's settings panel runs it (ADR 71).
// Confidentiality is not something to leave to
// whatever the parent directory happens to be: dirs are owner-only, files are owner-only.
// (A creation mode is masked by umask, so these are a ceiling, never a floor.)
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureDirs(home = boardHome()) {
  mkdirSync(boardsDir(home), { recursive: true, mode: DIR_MODE });
  mkdirSync(pagesDir(home), { recursive: true, mode: DIR_MODE });
}

function boardPath(id, home = boardHome()) {
  return path.join(boardsDir(home), `${assertSafeId(id)}.json`);
}

function pagePath(id, home = boardHome()) {
  return path.join(pagesDir(home), `${assertSafeId(id)}.html`);
}

/** Atomic write: temp file in the same directory, fsync, then rename over the target.
 * The fsync is what makes the rename's atomicity mean anything after a hard stop: the
 * daemon runs under launchd `KeepAlive` and is SIGKILLed on reload, and a rename that
 * lands before the data it renames leaves a zero-length or truncated board file behind
 * — which is exactly the corrupt file listBoards below has to survive. */
function atomicWrite(targetPath, contents) {
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: DIR_MODE });
  const tmp = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    // Looped on the returned count. `fs.writeSync` issues exactly one
    // write(2) and returns the byte count -- it does not loop, and a short write
    // returns a partial count WITHOUT throwing. fsync+rename would then publish a
    // truncated file as the authoritative board: readBoard throws SyntaxError,
    // listBoards drops the file, and the thread disappears from the index. Node's
    // own writeFileSync loops in C++ for the same reason.
    const buf = Buffer.from(contents, 'utf8');
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`short write to ${tmp}: wrote ${off} of ${buf.length} bytes`);
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, targetPath);
}

export function readBoard(id, home = boardHome()) {
  try {
    const raw = readFileSync(boardPath(id, home), 'utf8');
    const board = JSON.parse(raw);
    // Every reader of a stored board comes through here (listBoards below reads
    // its entries with this function too), which is why the one fact a stored
    // board cannot know about itself is applied here rather than at each of the
    // five surfaces that would otherwise each need its own clock: a round whose
    // wait has already died stops being awaited. See closeLapsedAwaitedRounds
    // (src/badge.mjs) for why the flag moves and the deadline stays.
    closeLapsedAwaitedRounds(board);
    return board;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function writeBoard(board, home = boardHome()) {
  ensureDirs(home);
  atomicWrite(boardPath(board.id, home), JSON.stringify(board, null, 2));
  return board;
}

/** The path of a shared asset, from a name that may have come off the wire. Same
 * discipline as `boardPath` above: the pattern is enforced HERE, where a name becomes a
 * filesystem path, and not at the one route that reads one. */
function assetPath(name, home = boardHome()) {
  if (typeof name !== 'string' || !ASSET_NAME.test(name)) {
    throw Object.assign(new Error(`unsafe asset name: ${JSON.stringify(String(name))}`), { status: 400 });
  }
  return path.join(pagesDir(home), name);
}

/** Put the shared assets on disk, skipping any that is already there.
 *
 * Never overwrites, and that is the rule the whole scheme rests on (ADR 70): the name IS
 * the hash of the contents, so a file that exists under a given name already holds exactly
 * the bytes we would write, and every page ever written that names it is entitled to keep
 * getting them. An overwrite could only ever be a no-op or a corruption, so it is simply
 * not attempted.
 *
 * `atomicWrite` rather than a bare `openSync(..., 'wx')`: a create-in-place interrupted
 * mid-write would leave a TRUNCATED file that now exists, so this function would skip it
 * forever and every page naming it would load half a script. Temp-then-rename means a
 * crash leaves the target absent and the next write retries.
 *
 * `assets` is parameterised for the same reason `sharedAssets()` is — so a check can write
 * a stand-in "next version" of the payload through this exact code path. */
export function writeSharedAssets(home = boardHome(), assets = SHARED_ASSETS) {
  ensureDirs(home);
  for (const asset of assets) {
    const target = assetPath(asset.name, home);
    if (existsSync(target)) continue;
    atomicWrite(target, asset.contents);
  }
}

/** Writes the page, and the assets it names FIRST — never the other way round. A page is
 * reachable the instant it lands (the daemon serves it, Finder opens it), so publishing
 * one that names a file not yet on disk is a window in which the archive is broken. */
export function writePage(id, html, home = boardHome()) {
  ensureDirs(home);
  writeSharedAssets(home);
  atomicWrite(pagePath(id, home), html);
}

/** A shared asset's bytes, or null if this store has never written one under that name.
 * Bytes, not a string: this is served verbatim over HTTP, and re-encoding it through
 * UTF-16 and back to satisfy a `content-length` is work with nothing to show for it. */
export function readAsset(name, home = boardHome()) {
  try {
    return readFileSync(assetPath(name, home));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function readPage(id, home = boardHome()) {
  try {
    return readFileSync(pagePath(id, home), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** A cheap fingerprint of the boards directory: name, size and mtime of every stored
 * board, and nothing read or parsed. Two calls returning the same string mean no board
 * was added, removed, or written since the first — which is what lets a caller that would
 * otherwise `listBoards` skip the walk entirely.
 *
 * This exists for `GET /api/index/rows` (ADR.md entry 77), which every open index polls
 * every fifteen seconds. `listBoards` is a synchronous `readFileSync` + `JSON.parse` of
 * every board document on the event loop, and a page board's document can run to
 * megabytes — a cost `GET /` paid once per navigation and a poll would otherwise pay
 * forever, stalling every `/wait` long-poll and SSE heartbeat in the process. Almost
 * every tick finds nothing changed, so almost every tick now costs one `readdir` and a
 * `stat` per file.
 *
 * `mtimeMs` and `size` together rather than either alone: HFS+ and some network stores
 * carry second-resolution mtimes, so two writes inside one second can share a stamp, and
 * the size is what separates them when the content genuinely changed. A same-second write
 * that changes neither size nor mtime is the residual miss, and it costs one poll of
 * staleness — a fifteen-second-old index, which is the freshness the ADR promises anyway.
 *
 * Degrades to a unique string on any error, so an unreadable directory or a file that
 * vanished mid-walk always reads as "changed" and the caller falls through to the real
 * walk. Never the reverse: this must not be able to claim nothing changed when something
 * did. */
export function storeFingerprint(home = boardHome()) {
  try {
    const dir = boardsDir(home);
    const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.tmp-')).sort();
    const parts = [];
    for (const f of files) {
      const s = statSync(path.join(dir, f));
      parts.push(`${f}:${s.size}:${s.mtimeMs}`);
    }
    return parts.join('|');
  } catch (err) {
    if (err && err.code === 'ENOENT') return ''; // no store yet: a real, stable state
    return `unreadable:${Date.now()}:${Math.random()}`;
  }
}

export function listBoards(home = boardHome()) {
  let files;
  try {
    files = readdirSync(boardsDir(home));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const boards = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
    const id = f.slice(0, -'.json'.length);
    let board;
    try {
      board = readBoard(id, home);
    } catch (err) {
      // One unparseable file must not take the whole archive down with it: this is
      // what `GET /` (the closed-tab recovery path) and `/api/search` are built on, and
      // an unclean kill mid-write is a routine event here. Skip it, say so once per
      // walk, and keep going — every other board is still readable.
      console.warn(`claude-board: skipping unreadable store file boards/${f}: ${(err && err.message) || err}`);
      continue;
    }
    if (board) boards.push(board);
  }
  return boards;
}

/** Archive search: what was asked (question prompts, option labels), what was
 * answered (chosen values and notes) and when (round timestamps), across every
 * board in the store — see PROTOCOL.md "HTTP surface". The store is the only source: this walks
 * `listBoards` fresh on every call rather than maintaining a side index that could
 * drift from the board files.
 *
 * Returns one result per match (a board can contribute several), newest first:
 * `{ boardId, thread, cwd, title, kind, text, at }`, `kind` one of
 * `'title' | 'question' | 'option' | 'answer' | 'note'`.
 *
 * `boards` is an optional already-read store walk: a caller that has just called
 * `listBoards` itself (the index page, which renders the thread list and the search
 * results from the same request) passes it in rather than making this single-threaded
 * daemon read and JSON.parse every board file a second time. */
export function searchBoards(query, home = boardHome(), boards = null) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  if (!boards) boards = listBoards(home);
  const results = [];

  const roundStamp = (board, roundN, fallback) => {
    const r = (board.rounds || []).find(rr => rr.n === roundN);
    return (r && (r.sentAt || r.postedAt)) || fallback;
  };

  // Every field below is coerced with String() rather than assumed. src/board.mjs now
  // types them at the trust boundary, but this scan walks EVERY board in the store, so
  // one malformed field in one old file would otherwise throw out of the loop and take
  // archive search down for the whole store rather than for that board.
  const low = v => String(v ?? '').toLowerCase();

  for (const board of boards) {
    const base = { boardId: board.id, thread: board.thread, cwd: board.cwd, title: board.title };

    if (low(board.title).includes(q)) {
      results.push({ ...base, kind: 'title', text: board.title, at: board.createdAt });
    }

    for (const blk of board.blocks || []) {
      if (blk.kind !== 'question') continue;
      const askedAt = roundStamp(board, blk.round, board.createdAt);

      if (low(blk.prompt).includes(q)) {
        results.push({ ...base, kind: 'question', text: blk.prompt, at: askedAt });
      }

      for (const opt of blk.options || []) {
        if (low(opt.label).includes(q)) {
          results.push({ ...base, kind: 'option', text: `${opt.label} — option for "${blk.prompt}"`, at: askedAt });
        }
      }

      const answer = board.answers ? board.answers[blk.id] : null;
      if (!answer) continue;
      const answeredAt = roundStamp(board, blk.round, board.updatedAt);
      const choices = Array.isArray(answer.choice)
        ? answer.choice
        : (answer.choice != null ? [answer.choice] : []);
      for (const c of choices) {
        if (low(c).includes(q)) {
          results.push({ ...base, kind: 'answer', text: `${c} — answer to "${blk.prompt}"`, at: answeredAt });
        }
      }
      if (answer.note && low(answer.note).includes(q)) {
        results.push({ ...base, kind: 'note', text: answer.note, at: answeredAt });
      }
    }
  }

  results.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return results;
}

export function deleteBoard(id, home = boardHome()) {
  try { unlinkSync(boardPath(id, home)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  try { unlinkSync(pagePath(id, home)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

/** When a board last changed, as epoch ms — or `null` when it will not say.
 *
 * `updatedAt`, falling back to `createdAt`, both ISO-8601 strings `createBoard` always
 * sets; absent or unparseable only on a hand-edited or foreign-version file. A board that
 * states NEITHER answers `null`, and `pruneStore` below KEEPS it.
 *
 * That is the opposite of how src/indexpage.mjs's `stamp` treats an absent stamp (there,
 * absent collates as oldest so it sorts last), and the difference is deliberate: sorting
 * has to put such a board somewhere, while deleting does not. "Older than the window" is
 * a claim, and a board that cannot state its age has not been shown to meet it. A
 * destructive operation removes only what it can prove. The same rule covers a file that
 * will not parse at all — `listBoards` skips it with a warning, so a prune never sees it
 * and can never delete it. */
function boardTimeMs(board) {
  for (const v of [board && board.updatedAt, board && board.createdAt]) {
    if (typeof v !== 'string') continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Delete every shared asset in `pages/` that no page left in `pages/` still names.
 * Returns the filenames removed.
 *
 * The two namespaces in that directory are disjoint by construction (src/assets.mjs
 * `ASSET_NAME`): an asset name carries a dot before its extension and can never be a
 * board id, and a page is `<id>.html`. Both filters skip `.tmp-` files for the reason
 * `listBoards` does — one of those is an `atomicWrite` mid-flight, and deleting it races
 * the rename.
 *
 * `assetsNamedBy` scans a page's bytes rather than parsing it, so it over-reports rather
 * than under-reports (a name that appears anywhere, `#board-data` included, counts as a
 * reference). For a garbage collector that is the safe direction: the failure it makes
 * impossible is deleting an asset a page still loads.
 *
 * Scanned for references: every `.html` page, AND every asset itself. Not every asset
 * is named directly by a page any more (ADR 70's mermaid extension) — the vendored
 * engine is loaded only from inside the SCRIPT asset, on demand, never from a page's own
 * markup (src/ui.mjs's own comment on why) — so a page's bytes alone no longer answer
 * "what does this archive depend on". Scanning every surviving asset's bytes too, not
 * just every page's, is what lets that indirect reference (ui.js naming mermaid.js the
 * same way a page names ui.js) keep the engine alive across a sweep; see
 * src/assets.mjs's `assetsNamedBy` for the fuller version of this comment.
 *
 * ponytail: reads every surviving page and asset in full, so a prune is O(bytes in
 * `pages/`) — tens of MB on a long-lived store, seconds at worst, and it only ever runs
 * when a person clicks. If that ever stops being true, the upgrade is a reference index
 * written beside the page; nothing here depends on the scan being a scan.
 *
 * ponytail: a prune that runs while a DIFFERENT process is midway through `writePage`
 * can delete an asset that write has already put down and is about to name (assets land
 * first, deliberately). Not reachable from one daemon — it is single-threaded and this
 * runs synchronously inside a request — and a second daemon over one store is not a
 * supported shape. The upgrade, if it ever is: take a lock over `pages/` for the sweep. */
function sweepUnreferencedAssets(home) {
  const dir = pagesDir(home);
  let files;
  try {
    files = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const assets = files.filter(f => ASSET_NAME.test(f));
  if (!assets.length) return [];

  const referenced = new Set();
  for (const f of files) {
    const isPage = f.endsWith('.html');
    const isAsset = ASSET_NAME.test(f);
    if ((!isPage && !isAsset) || f.includes('.tmp-')) continue;
    let text;
    try {
      text = readFileSync(path.join(dir, f), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // vanished under us: not a survivor
      throw err;
    }
    for (const name of assetsNamedBy(text)) referenced.add(name);
  }

  const removed = [];
  for (const name of assets) {
    if (referenced.has(name)) continue;
    try { unlinkSync(path.join(dir, name)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    removed.push(name);
  }
  return removed;
}

/** Remove every board older than `days`, document and emitted page alike, then every
 * shared asset no surviving page still names. Returns `{ boards, assets }` — the ids and
 * the filenames actually removed.
 *
 * THE WINDOW HAS NO DEFAULT, and that is the decision this signature exists to enforce
 * (ADR 71): the one number that decides what dies is named at the call, never implied.
 * A call that does not name one is refused rather than filled in with something
 * plausible. `status: 400` for the same reason `assertSafeId` throws one — this is
 * reachable from the wire, so a missing window is a refusal, not a 500.
 *
 * A flat age rule with no exemption, not even for a board holding a question nobody ever
 * answered. Blunt on purpose, and safe to be blunt only because nothing but a person ever
 * fires it: there is no sweep, no expiry, no daemon-start reap and no timer anywhere that
 * reaches this function.
 *
 * Ordered boards-then-assets, never the reverse: the asset sweep decides what to keep by
 * reading the pages that are STILL THERE, so it has to run after the pages that are going
 * have gone, or it would preserve assets for boards this same call just deleted. */
export function pruneStore(days, home = boardHome(), now = Date.now()) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw Object.assign(
      new Error(`prune needs a window, in days, greater than zero: got ${JSON.stringify(days)}`),
      { status: 400 }
    );
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const boards = [];
  let files;
  try {
    files = readdirSync(boardsDir(home));
  } catch (err) {
    if (err.code === 'ENOENT') return { boards, assets: [] }; // nothing has ever been written here
    throw err;
  }
  for (const f of files) {
    // `.tmp-` skipped for the reason `listBoards` skips it, and here it matters more: one
    // of those is an `atomicWrite` mid-flight, and unlinking it races the rename that is
    // about to publish a board.
    if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
    const id = f.slice(0, -'.json'.length);
    let board;
    try {
      board = readBoard(id, home);
    } catch {
      continue; // unparseable, or a filename that cannot be an id: never delete what you cannot read
    }
    if (!board) continue;
    // The FILENAME is what `deleteBoard` builds both paths from, so a file whose stored
    // `id` disagrees with its name is left alone rather than guessed at: deleting on the
    // stored id would unlink a DIFFERENT board's document and page, and deleting on the
    // filename would leave this one's page (written as `<board.id>.html`) behind. Such a
    // file is already unreachable through every other surface — the index links
    // `/b/<board.id>`, which 404s — so a prune is not the place to start acting on it.
    if (board.id !== id) continue;
    const at = boardTimeMs(board);
    if (at === null || at >= cutoff) continue;
    deleteBoard(id, home);
    boards.push(id);
  }
  // The boards above are already gone -- unlinked one at a time, irreversibly -- by the
  // time this runs (see the ordering comment above). A sweep failure must not swallow
  // that: name how many boards this call already removed before naming what the sweep
  // itself hit, so a 500 here is still actionable rather than an opaque fs error with no
  // sense of how much of the prune actually happened.
  let assets;
  try {
    assets = sweepUnreferencedAssets(home);
  } catch (err) {
    throw Object.assign(
      new Error(`prune deleted ${boards.length} board(s), then failed sweeping assets: ${err.message}`),
      { status: err.status || 500 }
    );
  }
  return { boards, assets };
}
