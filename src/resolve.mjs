// Content-by-reference resolution and sha snapshotting. See PROTOCOL.md "Board
// document" (the `Ref` shape) and DESIGN.md "Questions by value, content by
// reference, snapshotted at post time".
//
// The agent addresses content with `{ path, section?, lines? }`; this module reads
// the file exactly once, slices it to the section or line range, and returns the
// resolved text plus its sha256 so board.mjs can copy both into the board JSON at
// post time and never re-read the source again. Content must never pass through the
// model — that is where paraphrase creeps in.
//
// Resolve failures (missing file, bad range, missing section) are returned as
// `{ error }`, never thrown: board.mjs stores the error on the block instead of
// dropping it, so a bad reference is visible on the page rather than silently
// swallowed. That includes every confinement and stat refusal added below — a
// refused reference is a block-level error, never an exception that aborts a post.
//
// Confinement (audit C2): a reference names a file *inside the board's project*,
// and nothing else. The agent-supplied `ref.path` is untrusted input that ends up
// verbatim in the board JSON and on the served page, so an absolute path is
// refused outright and a relative one is resolved through `realpathSync` and
// required to still sit under the board's `cwd` afterwards — which is what stops
// `../../../../etc/hosts` and a symlink pointing out of the project alike.
//
// Liveness (audit H5): the daemon is single-threaded and resolves references
// inline on the request, so a reference naming a fifo (`readFileSync` on one blocks
// forever) or a character device / multi-GB file would wedge or exhaust the whole
// process — every board, health and SSE with it. Everything is `statSync`'d first:
// only regular files under MAX_REF_BYTES are ever opened.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { slugify } from './markdown.mjs';

/** Byte cap on one block's content, whether read from disk here or supplied by
 * value (src/board.mjs applies the same number to `text`/`html`). Generous next to
 * any file a human would put on a review board, small enough that a hostile or
 * accidental reference cannot exhaust the daemon's heap — and small enough to bound
 * every downstream scanner (markdown block parsing, src/anchor.mjs's html tree)
 * that runs inline on the request thread. */
export const MAX_REF_BYTES = 512 * 1024;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Validate and canonicalise a board's project directory. Returns `{ path }` with the
 * realpath, `{ path: null }` for "this board has no project directory", or `{ error }`.
 *
 * Confining references to `cwd` buys nothing while the caller also chooses `cwd`:
 * `cwd: '/'` plus a relative path reaches the whole filesystem. This is the other half
 * of that (audit C2). It cannot make the choice unforgeable — see `bindBoardCwd` in
 * src/board.mjs for exactly what this does and does not achieve — but it does make the
 * value CANONICAL (so what is stored on the board is the real directory the reads were
 * confined to, auditable after the fact) and refuses the values whose only purpose is
 * breadth:
 *
 *   relative                 meaningless: it would resolve against the daemon's own cwd
 *   not an existing dir      a project directory that is not there is a mistake, not a scope
 *   the filesystem root      `/` is not a project
 *   $HOME, or above it       `/Users`, `/home`, `~` -- every project at once, plus keys,
 *                             browser profiles and shell history
 */
export function resolveBoardCwd(cwd) {
  if (cwd == null) return { path: null };
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { error: 'cwd must be a non-empty absolute path, or omitted' };
  }
  if (!path.isAbsolute(cwd)) {
    return { error: `cwd must be an absolute path, got ${cwd}` };
  }
  let real;
  try {
    real = realpathSync(cwd);
  } catch (err) {
    return { error: `cwd ${cwd} does not exist or is not readable: ${err.code || err.message}` };
  }
  let st;
  try {
    st = statSync(real);
  } catch (err) {
    return { error: `cwd ${cwd} is not readable: ${err.code || err.message}` };
  }
  if (!st.isDirectory()) return { error: `cwd ${cwd} is not a directory` };
  if (real === path.parse(real).root) {
    return { error: `refusing cwd ${cwd}: the filesystem root is not a project directory` };
  }
  const home = homedir();
  if (home && contains(real, home)) {
    return { error: `refusing cwd ${cwd}: $HOME (or a directory above it) is too broad to be a project directory` };
  }
  return { path: real };
}

/** Is `parent` an ancestor of, or equal to, `child`? Both must already be absolute
 * and canonical. Shared by the cwd check above and the per-reference confinement
 * below so "inside the project" means one thing in this module. */
function contains(parent, child) {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/** Resolve `ref.path` against `cwd` and confine it there. Returns `{ path }` with
 * the fully-resolved real path on success, or `{ error }` — never a bare string,
 * never a throw. `cwd` is the board's `cwd` — the project directory of the session
 * that owns the thread — so a relative ref means "relative to that session's
 * project", not to wherever the daemon process happens to be running.
 *
 * Three refusals, in order: an absolute path (the agent addresses content inside
 * the project, so an absolute path is never legitimate and `/etc/passwd` is the
 * exact string this closes); a path that does not exist; and a path whose realpath
 * — symlinks already followed — lands outside `cwd`, which covers both `../`
 * traversal and a symlink inside the project aimed out of it. */
export function resolvePath(ref, cwd) {
  if (!ref || !ref.path) return { error: 'reference has no path' };
  if (typeof ref.path !== 'string') return { error: 'reference path must be a string' };
  if (path.isAbsolute(ref.path)) {
    return { error: `refusing absolute reference path ${ref.path}: references resolve inside the board's project directory` };
  }
  // No cwd, no reference. Falling back to `process.cwd()` used to make a board with no
  // project directory resolve against whatever directory launchd happened to start the
  // daemon in -- a directory nobody chose, that no board records, and that is plausibly
  // `/`. A reference needs a project to be relative TO; without one it is an error, not
  // a guess.
  if (!cwd) {
    return { error: `cannot resolve ${ref.path}: this board has no project directory` };
  }
  let root;
  try {
    root = realpathSync(cwd);
  } catch (err) {
    return { error: `cannot resolve project directory: ${err.code || err.message}` };
  }
  let real;
  try {
    real = realpathSync(path.resolve(root, ref.path));
  } catch (err) {
    return { error: `cannot read ${ref.path}: ${err.code || err.message}` };
  }
  if (real === root || !contains(root, real)) {
    return { error: `refusing reference ${ref.path}: resolves outside the board's project directory` };
  }
  return { path: real };
}

/** The file's lines, with the phantom trailing element a final newline produces
 * dropped. A 3-line file written as "a\nb\nc\n" splits into 4 elements; counting
 * that fourth one as a line is what let `lines: [4, 4]` come back as an empty,
 * error-free slice (rendering an empty <pre> the reviewer cannot interpret) instead
 * of the out-of-range error PROTOCOL.md's `error` field exists for. */
function fileLines(text) {
  const all = text.split('\n');
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  return all;
}

/** Slice `text` to 1-based inclusive line range `[from, to]`. Both ends are bounds
 * checked: a range starting past the end of the file, and one whose `to` is past it,
 * are errors, not a silent empty slice. */
function sliceLines(text, lines) {
  if (!Array.isArray(lines) || lines.length !== 2) {
    return { error: `lines must be [from, to], got ${JSON.stringify(lines)}` };
  }
  const [from, to] = lines;
  const all = fileLines(text);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return { error: `bad line range: [${from}, ${to}]` };
  }
  if (from > all.length) {
    return { error: `line range [${from}, ${to}] starts past end of file (${all.length} lines)` };
  }
  if (to > all.length) {
    return { error: `line range [${from}, ${to}] ends past end of file (${all.length} lines)` };
  }
  return { text: all.slice(from - 1, to).join('\n') };
}

/** Is `line` a fenced-code delimiter? src/markdown.mjs consumes fences before it
 * ever looks for a heading, so this scanner has to as well (audit): without the
 * toggle, a `# Install deps` COMMENT inside a ```sh block reads as a heading here.
 * That truncated the enclosing section at the fence with no error at all, and — far
 * worse — shifted every following heading's duplicate-slug ordinal out of step with
 * the anchors markdown.mjs minted from the same file, so `section: 'notes-2'` sliced
 * a different place than the `notes-2` anchor the agent was shown. */
function isFence(line) {
  return /^```/.test(line.trim());
}

/** Slice `text` to the markdown heading matching `section` (a heading slug, minted
 * with the same `slugify` markdown.mjs uses for anchors) and its body, up to but not
 * including the next heading of equal or shallower level. Fenced code is skipped on
 * both scans, exactly as markdown.mjs skips it. */
function sliceSection(text, section) {
  const lines = text.split('\n');
  const used = new Set();
  let startIdx = -1;
  let startLevel = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    const level = h[1].length;
    const slug = slugify(h[2], used);
    if (slug === section) {
      startIdx = i;
      startLevel = level;
      break;
    }
  }
  if (startIdx === -1) return { error: `section "${section}" not found` };
  let endIdx = lines.length;
  inFence = false;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (isFence(lines[j])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = lines[j].match(/^(#{1,6})\s+(.*)$/);
    if (h && h[1].length <= startLevel) {
      endIdx = j;
      break;
    }
  }
  return { text: lines.slice(startIdx, endIdx).join('\n') };
}

/** Resolve one content-by-reference `{ path, section?, lines? }` to its snapshotted
 * text and sha, reading the file exactly once. `section` and `lines` are mutually
 * exclusive selectors; neither means the whole file. On any failure (missing file,
 * bad range, section not found, path refused, not a regular file, over the byte
 * cap) returns `{ error }` instead of throwing, so a bad reference surfaces as a
 * block-level error rather than aborting the whole post. */
export function resolveRef(ref, { cwd } = {}) {
  if (!ref || !ref.path) return { error: 'reference has no path' };
  const confined = resolvePath(ref, cwd);
  if (confined.error) return { error: confined.error };
  const abs = confined.path;

  // stat before open: readFileSync on a fifo blocks the daemon's only thread
  // forever, and on a character device (/dev/zero) or an oversized file it eats
  // the heap. Both are refusals, not reads.
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    return { error: `cannot read ${ref.path}: ${err.code || err.message}` };
  }
  if (!st.isFile()) {
    return { error: `refusing ${ref.path}: not a regular file` };
  }
  if (st.size > MAX_REF_BYTES) {
    return { error: `refusing ${ref.path}: ${st.size} bytes exceeds the ${MAX_REF_BYTES}-byte reference cap` };
  }

  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    return { error: `cannot read ${ref.path}: ${err.code || err.message}` };
  }

  let sliced = { text: raw };
  if (ref.section) {
    sliced = sliceSection(raw, ref.section);
  } else if (ref.lines) {
    sliced = sliceLines(raw, ref.lines);
  }
  if (sliced.error) return { error: sliced.error };

  return { text: sliced.text, sha: sha256(sliced.text) };
}

// Best-effort file-extension -> language guess for a resolved code block's `lang`
// field, when the caller doesn't pass one explicitly. Unknown extensions fall back
// to ''; this is display-only (no syntax highlighting — see DESIGN.md "Out of
// Scope"), so a wrong or missing guess costs nothing but a label.
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  html: 'html', css: 'css', sql: 'sql', swift: 'swift', kt: 'kotlin',
};

export function langForPath(p) {
  const ext = path.extname(p || '').slice(1).toLowerCase();
  return EXT_LANG[ext] || '';
}
