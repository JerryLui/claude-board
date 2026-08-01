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
// Confinement (audit C2, widened by ADR.md entry 3, narrowed again by audit
// 2026-07-31): a reference names a file inside the board's project *or* inside one
// of a configured set of reference roots, and nothing else. The agent-supplied
// `ref.path` is untrusted input that ends up verbatim in the board JSON and on the
// served page, so every path is resolved through `realpathSync` and required to
// still sit under `cwd` or under an allowlisted root afterwards — which is what
// stops `../../../../etc/hosts` and a symlink pointing out of the project alike. An
// absolute path is refused unless it lands inside an allowlisted root, since a
// project file is always reachable relatively and `/etc/passwd` is the exact string
// that closes.
//
// The allowlist is `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths). An
// ABSENT variable is an EMPTY allowlist — the cwd-only boundary — and the default a
// user actually gets is written into the launchd plist by `install.sh`; see
// `resolveRefRoots` for why the default lives there and not here, and
// `DEFAULT_REF_ROOTS` for what it is. Each root is validated by `resolveBoardCwd` —
// the same realpath / must-exist / not-`/`-or-`$HOME` treatment the board's own `cwd`
// gets — and an unusable root is DROPPED rather than thrown, since a typo in an env
// var must never widen the gate nor take the daemon down. Resolving a reference is
// only ever a read, so the allowlist is read-only by construction.
//
// Liveness (audit H5) and the check/read gap (audit S2, 2026-07-31): the daemon is
// single-threaded and resolves references inline on the request, so a reference naming
// a fifo (`readFileSync` on one blocks forever) or a character device / multi-GB file
// would wedge or exhaust the whole process — every board, health and SSE with it. That
// guard, and the confinement above, both used to be decided on a path STRING that the
// read then re-opened by name. Two lookups of one name are two inodes the moment
// anything moves in between, so a symlink flipped between the `realpathSync` and the
// `readFileSync` was read from a file the checks never saw — measured at a ~1.2% win
// rate over 91k attempts, and it carried a private key out. So the file is now opened
// exactly ONCE, refusing to follow a symlink while it does, and every later question —
// regular file? under the byte cap? what are its bytes? — is asked of that one
// descriptor with `fstatSync`/`readFileSync(fd)` and never of the name again.
//
// Known limit, documented rather than fixed (audit S8, 2026-07-31): a HARD link inside
// an allowlisted root, pointing at a file outside every root, defeats all of the above.
// A hard link is not a link as far as path resolution is concerned — it is a second,
// equally real name for one inode, and neither `realpath` nor a descriptor can tell it
// from the first. Refusing `st.nlink > 1` was considered and rejected: it also refuses
// legitimately hard-linked content (content-addressed stores, `cp -l`, some backup
// tools) and nothing distinguishes the two cases, so it would trade a narrow escape for
// a class of false refusals. SECURITY.md states it under "Not defended, by design".

import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
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

/** The allowlist `install.sh` writes into the launchd plist when the user names none.
 * Exported so `test/check-install.mjs` can pin the installer's default against the one
 * place this project states it, rather than against a second copy of the same list.
 *
 * Three directories, not the whole of `~/.claude` (audit S1, 2026-07-31). The case
 * ADR.md entry 3 argues for is "render the skill, command or agent file this session is
 * discussing", and that is exactly these three; `~/.claude` as a whole also holds
 * `settings.json`, `.credentials.json`, shell snapshots, project transcripts and every
 * plugin's private state, none of which any board has a reason to quote. Anyone who
 * wants the whole tree can still say so: `CLAUDE_BOARD_REF_ROOTS=~/.claude` does
 * precisely what it says. */
export const DEFAULT_REF_ROOTS = Object.freeze([
  '~/.claude/skills',
  '~/.claude/commands',
  '~/.claude/agents',
]);

/** macOS `O_NOFOLLOW_ANY` (`<sys/fcntl.h>`, macOS 11+): refuse the open outright if ANY
 * component of the path is a symlink, not just the final one. Node does not export it.
 * Verified against this OS by `test/check-pure.mjs` rather than trusted from a header,
 * and only ever OR'd in on darwin — the number is Apple's, and it is `O_TMPFILE`-adjacent
 * territory on other platforms. */
const O_NOFOLLOW_ANY = 0x20000000;

/** How `resolveRef` opens the one descriptor it reads from.
 *
 * `O_NOFOLLOW_ANY` (or plain `O_NOFOLLOW` off darwin) is the whole point: the path being
 * opened is already a `realpathSync` result, so by construction it contains no symlink at
 * all, and an open that fails with ELOOP means the tree changed under us between the
 * check and the read — exactly the race audit S2 exploited. Refusing is correct there;
 * following would be reading a file nothing ever confined.
 *
 * `O_NONBLOCK` is what keeps the fifo guard a guard: `open` on a fifo with no writer
 * blocks forever, which would wedge the daemon's only thread before `fstatSync` ever got
 * a chance to say "not a regular file". With it the open returns immediately and the
 * descriptor is then refused on its type like anything else.
 *
 * The two NOFOLLOW flags are mutually exclusive on macOS — passing both is EINVAL, on
 * every path including ordinary files. See QUIRKS.md. */
const REF_OPEN_FLAGS = constants.O_RDONLY
  | constants.O_NONBLOCK
  | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW);

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
  if (isHomeOrAbove(real)) {
    return { error: `refusing cwd ${cwd}: $HOME (or a directory above it) is too broad to be a project directory` };
  }
  return { path: real };
}

/** Is the canonical `real` $HOME itself, or a directory above it — under ANY name?
 *
 * This used to be a string comparison against `homedir()`, which macOS defeats twice over
 * (audit S4, 2026-07-31), three ways. `realpathSync` does not correct case on a
 * case-insensitive volume, so `/users/you` canonicalises to itself and reads as "not
 * $HOME"; APFS firmlinks make `/System/Volumes/Data/Users/you` a second canonical
 * spelling of the same directory that no amount of string work relates to the first; and
 * `homedir()` itself was never realpath'd, so a symlinked `HOME` did not match the
 * already-canonical candidate either. All three were ACCEPTED as reference roots and as
 * board project directories, i.e. the one refusal whose whole job is "not every project
 * at once, plus keys and shell history" could simply be spelled around.
 *
 * So identity is decided on `dev`+`ino`, which is the only thing that survives an alias.
 * The walk goes up $HOME's own ancestry rather than down `real`'s: at each rung, `real`
 * stands in for that rung exactly when `real` joined with the remaining path down to
 * $HOME lands ON $HOME's inode. Rung zero (an empty tail) is "`real` IS $HOME under
 * another name"; the rung at `/` is what catches `/System/Volumes/Data`, whose own inode
 * is nobody's ancestor but which contains every home on the machine.
 *
 * The lexical test is kept as a cheap pre-filter for the ordinary spelling only — it is
 * an optimisation now, never the decision. */
function isHomeOrAbove(real) {
  const home = homedir();
  if (!home) return false;
  if (contains(real, home)) return true;
  let homeReal;
  let homeId;
  try {
    homeReal = realpathSync(home);
    homeId = statSync(homeReal);
  } catch {
    return false; // no readable $HOME to be above
  }
  for (let rung = homeReal; ; rung = path.dirname(rung)) {
    const tail = path.relative(rung, homeReal);
    try {
      const st = statSync(tail ? path.join(real, tail) : real);
      if (st.dev === homeId.dev && st.ino === homeId.ino) return true;
    } catch {
      // Nothing at that spelling: this rung is simply not what `real` names.
    }
    if (path.dirname(rung) === rung) return false;
  }
}

/** Is `parent` an ancestor of, or equal to, `child`? Both must already be absolute
 * and canonical. Shared by the cwd check above and the per-reference confinement
 * below so "inside the project" means one thing in this module. */
function contains(parent, child) {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/** The allowlist a reference may resolve inside, on top of the board's own `cwd`.
 * `spec` is the raw `CLAUDE_BOARD_REF_ROOTS` value: colon-separated absolute paths.
 *
 * **An absent variable is an EMPTY allowlist** (audit S3, 2026-07-31), and the choice is
 * deliberate enough to spell out. The alternative — absent meaning `DEFAULT_REF_ROOTS` —
 * reads better in a dev shell and is wrong here, because of how this daemon updates:
 * every install predating ADR.md entry 3 has a plist carrying no such key, and the daemon
 * restarts itself the moment `src/` changes. A default compiled in HERE therefore takes
 * effect on those machines on the next `git pull`, with no reinstall, nothing printed and
 * nobody asked — a security boundary widening itself during a routine sync. A default
 * written by `install.sh` cannot do that: it takes effect when someone runs the installer,
 * which is a thing a person does on purpose. So the value that ships is `DEFAULT_REF_ROOTS`
 * spelled into the plist, and the code's own answer to "nothing configured" is the
 * narrowest one it has. `CLAUDE_BOARD_REF_ROOTS=` (explicitly empty) means the same thing
 * and stays supported, since that is what an existing plist may already say.
 *
 * Every entry is validated by `resolveBoardCwd`, i.e. exactly as the board's own
 * project directory is: realpath'd, must be an existing directory, refused if it is
 * `/` or `$HOME` or above. A root that fails any of that is DROPPED — never thrown,
 * never widened to something broader. A misconfigured env var must not take the
 * daemon down (it resolves references inline on the request thread) and must not
 * quietly grant more than it names. Dropping one entry and keeping its neighbours is
 * right for the failures that are unambiguous — a root that does not exist yet is
 * exactly the entry it looks like, and `DEFAULT_REF_ROOTS` names three directories not
 * every machine has.
 *
 * One failure is NOT unambiguous, and it fails the whole spec closed (audit S9,
 * 2026-07-31): a non-absolute entry. `:` separates entries and `:` is also legal in a
 * directory name, so `/data/my:dir` splits into `/data/my` and `dir` — and the old code
 * dropped the unusable `dir` and granted `/data/my`, an unrelated sibling directory the
 * user never named, silently. There is no spelling that recovers the intended root, so
 * the honest answer is that the spec cannot be parsed as written and grants nothing.
 * Every other entry shape here is absolute, so this costs nothing a correct spec wanted.
 *
 * A leading `~` is expanded, because this value travels through a launchd plist,
 * where nothing expands it and a literal `~/.claude` would otherwise be silently
 * dropped as "not absolute".
 *
 * Deliberately NOT memoized: it is a handful of syscalls per resolved reference,
 * which happens at post time only, and re-reading means a check (or a user) can
 * change the env var and see the effect without a fresh process. */
export function resolveRefRoots(spec) {
  if (spec == null) return [];
  const home = homedir();
  const roots = [];
  for (const entry of String(spec).split(':')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let expanded = trimmed;
    if (home && (trimmed === '~' || trimmed.startsWith('~/'))) {
      expanded = trimmed === '~' ? home : path.join(home, trimmed.slice(2));
    }
    if (!path.isAbsolute(expanded)) return [];
    const validated = resolveBoardCwd(expanded);
    if (validated.error || !validated.path) continue;
    if (!roots.includes(validated.path)) roots.push(validated.path);
  }
  return roots;
}

/** Is the canonical `real` inside one of `roots` (and not a root itself, which is a
 * directory and never a reference target)? */
function insideRoots(real, roots) {
  return roots.some(root => real !== root && contains(root, real));
}

/** Does the absolute `p` at least NAME a place inside the boundary — directly inside an
 * allowlisted root, or (when `cwd` is given) inside the board's project directory?
 *
 * Decided on the REALPATH of `p`'s parent directory, never on `p`'s own spelling: on
 * macOS `/var`, `/tmp` and an external-volume home are all symlinks, so a lexical
 * comparison against realpath'd roots reads a perfectly legitimate path as an escape
 * (QUIRKS.md). Its only job is choosing which refusal to report; it never decides
 * whether to read. */
function namesPlaceInside(p, roots, cwd = null) {
  let parent;
  try {
    parent = realpathSync(path.dirname(p));
  } catch {
    return false;
  }
  if (roots.includes(parent) || insideRoots(parent, roots)) return true;
  return Boolean(cwd) && (parent === cwd || contains(cwd, parent));
}

/** Does something exist at this exact name — a file, a directory, a dangling symlink,
 * anything? `lstat`, so a symlink counts as present without its target being consulted;
 * that is the difference between "you spelled a file that is not here" and "you spelled
 * a link and it goes somewhere I will not follow". */
function nameExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `ref.path` against `cwd` and confine it to `cwd` or the allowlist.
 * Returns `{ path }` with the fully-resolved real path on success, or `{ error }` —
 * never a bare string, never a throw. `cwd` is the board's `cwd` — the project
 * directory of the session that owns the thread — so a relative ref means "relative
 * to that session's project", not to wherever the daemon process happens to be
 * running. `roots` is the allowlist (ADR.md entry 3); it defaults to whatever
 * `CLAUDE_BOARD_REF_ROOTS` names, and is a parameter so a check can pin it.
 *
 * The refusals, in order: an absolute path that does not even name a place inside an
 * allowlisted root (the agent addresses project content relatively, so `/etc/passwd`
 * is the exact string this closes); a path that does not exist; and a path whose
 * realpath — symlinks already followed — lands outside `cwd` AND outside every root,
 * which covers `../` traversal and a symlink aimed out of the project or out of a
 * root alike. The refusal messages are unchanged from the cwd-only boundary: a
 * reference outside everything is refused exactly as it always was.
 *
 * WHICH refusal comes back is decided only on names inside the boundary (audit S7,
 * 2026-07-31). It used to splice `err.code` from the failed `realpathSync` into the
 * message, which made every refusal an existence-and-errno oracle for the whole disk:
 * point a symlink from inside an allowlisted root at any path you like, and ENOENT
 * versus EACCES versus ELOOP told you what was there. Now a reference that is present
 * but does not resolve inside the boundary reports the same "resolves outside" refusal
 * whether its target exists, is unreadable or was never there, and the only thing a
 * caller can still learn is whether a name it is already allowed to read exists — which
 * is what makes a typo inside a root read as the missing file it is instead of sending
 * the agent looking for a confinement bug.
 *
 * What this does NOT decide is what kind of thing the path names. A returned `{ path }`
 * means "inside the boundary", not "a readable regular file": a directory inside a root
 * resolves here and is refused by `resolveRef` on the open descriptor. That split is
 * deliberate rather than an omission — asking the name a second time is the check/read
 * gap audit S2 closed, so the only place entitled to answer "is this a regular file" is
 * the descriptor the bytes will actually come from. */
export function resolvePath(ref, cwd, roots = resolveRefRoots(process.env.CLAUDE_BOARD_REF_ROOTS)) {
  if (!ref || !ref.path) return { error: 'reference has no path' };
  if (typeof ref.path !== 'string') return { error: 'reference path must be a string' };
  const absoluteRefusal = { error: `refusing absolute reference path ${ref.path}: references resolve inside the board's project directory` };
  const outsideRefusal = { error: `refusing reference ${ref.path}: resolves outside the board's project directory` };
  const missing = { error: `cannot read ${ref.path}: no such file` };

  if (path.isAbsolute(ref.path)) {
    let realAbs = null;
    try {
      realAbs = realpathSync(ref.path);
    } catch {
      realAbs = null; // dangling, unreadable, a loop -- all one answer, see above
    }
    if (realAbs !== null && insideRoots(realAbs, roots)) return { path: realAbs };
    // Refused. An absolute path that does not even name a place inside a root is just
    // an absolute path, refused exactly as it always was; one that does is either a
    // name that is not there (a typo) or something that left the root, and the two are
    // told apart by lstat'ing the reference ITSELF, never by what its target turned
    // out to be.
    if (!namesPlaceInside(ref.path, roots)) return absoluteRefusal;
    if (realAbs === null && !nameExists(ref.path)) return missing;
    return outsideRefusal;
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
  // The same treatment for a relative path, which reaches every absolute path on the
  // disk through enough `../` and so leaked the identical oracle.
  const candidate = path.resolve(root, ref.path);
  let real = null;
  try {
    real = realpathSync(candidate);
  } catch {
    real = null;
  }
  // `real !== root` sits OUTSIDE the disjunction on purpose. It used to be a term of the
  // first branch only, so the `insideRoots` fallback cancelled it whenever the project
  // directory happened to live under an allowlisted root, and `{ path: <the project
  // directory> }` came back as a successful resolution (audit NEW-3, 2026-07-31). The
  // project directory is never a reference target, wherever the project happens to sit.
  if (real !== null && real !== root && (contains(root, real) || insideRoots(real, roots))) {
    return { path: real };
  }
  if (!namesPlaceInside(candidate, roots, root)) return outsideRefusal;
  if (real === null && !nameExists(candidate)) return missing;
  return outsideRefusal;
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
  // Trailing CR stripped per line, matching src/markdown.mjs's identical pass: `$`
  // does not match `\r`, so every heading in a CRLF file failed this regex and every
  // `section` ref against one reported "not found" (audit).
  const lines = text.split('\n').map(s => (s.endsWith('\r') ? s.slice(0, -1) : s));
  const used = new Set();
  // Beside `used`, for the same reason markdown.mjs carries one: without it a file of
  // N same-slug headings costs O(N^2), and a 512KiB one took 8.8 minutes here (audit).
  const ordinals = new Map();
  let startIdx = -1;
  let startLevel = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    const level = h[1].length;
    const slug = slugify(h[2], used, ordinals);
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
 * text and sha, opening the file exactly once. `section` and `lines` are mutually
 * exclusive selectors; neither means the whole file. On any failure (missing file,
 * bad range, section not found, path refused, not a regular file, over the byte
 * cap) returns `{ error }` instead of throwing, so a bad reference surfaces as a
 * block-level error rather than aborting the whole post.
 *
 * "Exactly once" is a security property, not an efficiency one (audit S2, 2026-07-31).
 * This used to `statSync(abs)` for the type and size guards and then `readFileSync(abs)`
 * for the bytes — three separate lookups of one name, counting the `realpathSync` that
 * confined it, and the boundary was therefore decided on one inode while the read
 * happened on whatever that name pointed at a moment later. A symlink swapped in between
 * won that race ~1.2% of the time and read a file outside every root. So the name is
 * resolved to a descriptor once, with symlinks refused at open, and the guards and the
 * read all interrogate that descriptor: whatever passes the checks is what is read,
 * because there is only one thing left to read. */
export function resolveRef(ref, { cwd, roots } = {}) {
  if (!ref || !ref.path) return { error: 'reference has no path' };
  const confined = resolvePath(ref, cwd, roots ?? resolveRefRoots(process.env.CLAUDE_BOARD_REF_ROOTS));
  if (confined.error) return { error: confined.error };
  const abs = confined.path;

  let fd;
  try {
    fd = openSync(abs, REF_OPEN_FLAGS);
  } catch (err) {
    // Includes ELOOP, which on an already-canonical path means the tree moved between
    // the check and this line. `abs` is inside the boundary either way, so reporting the
    // code costs nothing the caller was not already entitled to know.
    return { error: `cannot read ${ref.path}: ${err.code || err.message}` };
  }

  let raw;
  try {
    // fstat, not stat: readFileSync on a fifo blocks the daemon's only thread forever,
    // and on a character device (/dev/zero) or an oversized file it eats the heap. Both
    // are refusals, not reads -- and asking the descriptor rather than the name is what
    // makes the answer describe the bytes that follow.
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { error: `refusing ${ref.path}: not a regular file` };
    }
    if (st.size > MAX_REF_BYTES) {
      return { error: `refusing ${ref.path}: ${st.size} bytes exceeds the ${MAX_REF_BYTES}-byte reference cap` };
    }
    raw = readFileSync(fd, 'utf8');
  } catch (err) {
    return { error: `cannot read ${ref.path}: ${err.code || err.message}` };
  } finally {
    // Every path out of the block above, refusals included -- the daemon is long-lived
    // and a leaked descriptor per refused reference is an EMFILE waiting to happen.
    try { closeSync(fd); } catch { /* already gone */ }
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
