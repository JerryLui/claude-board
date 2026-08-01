// Board JSON persistence under CLAUDE_BOARD_HOME. See PROTOCOL.md "Paths".
//
// $CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
// $CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, standalone-openable
//
// Writes are atomic (temp file + rename) so a mid-write daemon restart cannot
// corrupt a board: a reader always sees either the old or the new content, never a
// partial one.

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// The default moved out of ~/Documents/renders/board on 2026-07-30 (SPEC_LAUNCH.md
// "The store moves to a conventional path and nothing migrates"): the renders
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
 * read and then OVERWROTE a file outside the store (audit 2026-07-31 S2). Minted ids are
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
// session and every project, indefinitely. Confidentiality is not something to leave to
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
    // Looped on the returned count (audit). `fs.writeSync` issues exactly one
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
    return JSON.parse(raw);
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

export function writePage(id, html, home = boardHome()) {
  ensureDirs(home);
  atomicWrite(pagePath(id, home), html);
}

export function readPage(id, home = boardHome()) {
  try {
    return readFileSync(pagePath(id, home), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
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
 * board in the store — see PROTOCOL.md "HTTP surface" and DESIGN.md Decisions
 * -> "Archived boards are searchable". The store is the only source: this walks
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

  for (const board of boards) {
    const base = { boardId: board.id, thread: board.thread, cwd: board.cwd, title: board.title };

    if ((board.title || '').toLowerCase().includes(q)) {
      results.push({ ...base, kind: 'title', text: board.title, at: board.createdAt });
    }

    for (const blk of board.blocks || []) {
      if (blk.kind !== 'question') continue;
      const askedAt = roundStamp(board, blk.round, board.createdAt);

      if ((blk.prompt || '').toLowerCase().includes(q)) {
        results.push({ ...base, kind: 'question', text: blk.prompt, at: askedAt });
      }

      for (const opt of blk.options || []) {
        if ((opt.label || '').toLowerCase().includes(q)) {
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
        if (String(c).toLowerCase().includes(q)) {
          results.push({ ...base, kind: 'answer', text: `${c} — answer to "${blk.prompt}"`, at: answeredAt });
        }
      }
      if (answer.note && answer.note.toLowerCase().includes(q)) {
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
