# PROTOCOL — shared contract for `claude-board`

The wire contract: the shapes on disk, the routes that move them, and what each side refuses.
`SECURITY.md` owns the rationale behind the gates; this file owns the enumerated rules and the
tables. `skills/claude-board/SKILL.md` is the prose manual a caller reads.

**Changing this file:** changes are additive. A shape that is not here gets a new field, added
here in the same commit that uses it. Do not repurpose or rename an existing field.

## Layout

| module | what it owns |
| --- | --- |
| `bin/daemon.mjs` | the HTTP server's entry point |
| `bin/mcp.mjs` | stdio MCP shim, one per Claude session |
| `bin/authorize.mjs` | the recovery command: mint a handoff and open the browser |
| `bin/launcher.c` | launchd entry point, compiled by `install.sh` into a signed app bundle that forks the daemon, so macOS TCC has an application of ours to attribute its file reads to |
| `bin/notify.m` | the bundle's `--notify` mode: one native notification, no `osascript` |
| `src/store.mjs` | board JSON persistence: read, write, list, search |
| `src/board.mjs` | the model: id minting, block normalisation, rounds, packet assembly |
| `src/markdown.mjs` | markdown -> HTML + anchor extraction; runs in node and in the browser |
| `src/anchor.mjs` | element-level (`dom`/`mermaid`) anchor path and hint logic, pure. `src/ui.mjs` carries a duplicate as plain functions, since the served page has no import graph at runtime |
| `src/resolve.mjs` | content-by-reference resolution and sha snapshotting |
| `src/render.mjs` | board JSON -> complete HTML page (pure function) |
| `src/indexpage.mjs` | daemon root: the thread index and its session filter |
| `src/server.mjs` | the `node:http` daemon: routes, SSE, the four gates below |
| `src/secret.mjs` | the two credentials: the local secret and the browser session cookie derived from it, shared by the daemon and the shim |
| `src/handoff.mjs` | single-use, seconds-lived browser handoffs, and `recoveryCommand()` |
| `src/ui.mjs` | client-side script for the board page, exported as a string |
| `src/styles.mjs` | page CSS, exported as a string |
| `src/theme.mjs` | client-side theme selection: storage key, `THEME_CHANGE_EVENT`, the pre-paint boot script, the control's markup |
| `src/patch.mjs` | pure board-JSON diff (added/changed block ids, rounds now sent), imported by the checks AND spliced verbatim into `src/ui.mjs` via `computeBoardPatch.toString()` |
| `src/badge.mjs` | pure, DOM-free facts about a round: the badge's label, `isPageRound`/`questionBlocks`, and the whole *Awaited* predicate family (`roundIsAwaited`, `closeLapsedAwaitedRounds`, the countdown and pill text). Imported by the store, the server and the index AND spliced verbatim into `src/ui.mjs`, so both sides answer "is anyone listening" from one definition |
| `src/lens.mjs` | the diagram lens's view math, pure |
| `src/prose-check.mjs` | the prose-vs-shim checker (below). Ships from `src/` so a caller outside this repo can import it |
| `src/cues.mjs` | the cue vocabulary: the closed set of legal cue values, enumerated live from BOTH sound directories (`/System/Library/Sounds` and `~/Library/Sounds`, ADR 20) plus `"None"`, memoised on a 5-second TTL |
| `src/pomodoro.mjs` | the global pomodoro clock: the pure boundary rule, the pomodoro day above it (05:00 to 05:00, ADR 67), the document's shape on disk, the impure shell the daemon boots. Absolute deadlines, so a restart is invisible and a deadline slept through expires silently |
| `src/pomodoro-widget.mjs` | the timer's server-rendered markup for the index page; its client half extends `src/indexpage.mjs`'s script by concatenation |
| `src/notify.mjs` | one native notification per interval boundary, carrying that phase's cue. The bundle's own executable in `--notify` mode inside `claude-board.app` (ADR 19), `osascript` only on the no-launcher clone install; message text and cue both come from closed-set lookups |
| `skills/claude-board/SKILL.md` | the manual for the `ask` tool, and the only prose statement of this protocol a caller reads. `install.sh` copies it to `~/.claude/skills/claude-board/` (ADR 11); `test/check-skill-prose.mjs` binds it to the live shim |
| `test/check-*.mjs` | the suite; `test/run.mjs` carries an explicit list of them rather than globbing, so a new check runs only once its filename is added there |

Zero *installed* dependencies: no `npm install`, no `node_modules`, no bundler, no build step;
ESM (`.mjs`) throughout. `marked` and `prismjs` are vendored as pinned, digest-guarded source
under `src/vendor/` (ADR 62) and run server-side at post time. Mermaid is the sole thing
fetched at view time, and stays client-side from its CDN.

## Paths

The store root is `CLAUDE_BOARD_HOME`, defaulting to
`~/Library/Application Support/claude-board`. Unlike the other env vars here, this one is
user-facing configuration as well as the seam the checks run against.

```
$CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
$CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, standalone-openable
$CLAUDE_BOARD_HOME/pomodoro.json            the pomodoro clock and its settings (ADR 8)
```

`pomodoro.json` is the one thing here that is not a board, and the one thing `uninstall.sh`
removes from this directory — by exact name, never a glob. It is configuration this repo
authored (a deadline, a break length), not review history the user accumulated. See
`src/pomodoro.mjs` for the document shape.

Daemon listens on `127.0.0.1:7391` (`CLAUDE_BOARD_PORT` overrides, for the checks).

## Identifiers

`th_<8 lowercase hex>` for threads, `b_<32 hex>` for boards, `q1` / `c3` / `m2` … for blocks
(kind letter + ordinal within the board, stable once minted). Comments are numbered `1..n`
across the whole board — that number is what appears in the pin.

The board id is 16 bytes; reads are gated, so it is defence in depth rather than the only defence.
A thread id is 4 bytes: an index label that authorises nothing.

A block id is **unique across the whole board**: `board.answers` is keyed by it, so a duplicate
is not a cosmetic clash, it is the agent being told an answer the reviewer never gave. A
caller-supplied `raw.id` is legitimate only on the amend "replace this exact block" path, and is
refused unless it (a) matches the minted shape, (b) carries the kind letter of the block it
names, and (c) is either unused or names a top-level block of the round currently being amended.
`addRound` refuses every id already on the board.

Kind letter, one per block kind (`m` is taken by mermaid, so markdown uses `d` for document):

```
question -> q     markdown -> d     mermaid -> m
code     -> c     html     -> h     compare  -> x
```

## Board document

```js
board = {
  id, thread, title,
  cwd,                              // project directory of the session that owns the thread
  createdAt, updatedAt,             // ISO 8601
  state,                            // 'open' | 'submitted' | 'discuss' | 'timeout'
  rounds: [ { n, postedAt, status, sentAt, title, action?, awaited, awaitDeadline } ],
                                     // status: 'open' | 'sent'
  blocks: [ Block ],                // every block of every round, in display order
  answers: { [questionBlockId]: Answer },
  comments: [ Comment ],
}
```

Answers are keyed at board level rather than nested in rounds; every block carries its own
`round`, which is what the board's pages group by (ADR 42: a round is a page, reached with
the pager's chevrons or by name from the pill at the bottom). `status` goes `open` → `sent` on
submit and nothing else moves it, so a round that asks nothing — an artifact page, which is not
sendable at all (ADR 35) — stays `open` for the life of the board, and more than one round can be
`open` at a time. "The open round" always means the latest one (see `POST /api/board` below). A round's `action` (`'submitted'` |
`'discuss'`) records that round's own outcome, which a later round's `addRound` cannot
overwrite the way it resets `board.state` to `'open'`.

**Round `title`.** Every round carries the `title` of the post that created it — `ask` requires
a non-empty one on every call. `createBoard` seeds round 1's from the board title, `addRound`
takes the post's (falling back to the board title), and `amendRound` may refine the open round's
but never blanks it. `src/render.mjs` renders it in the round heading: `Round 2 · fix/some-branch`,
plus ` · sent` once the round is out.

**Round `awaited` / `awaitDeadline`** (ADR 45, 47; CONTEXT.md "Awaited"). `awaited` is a
boolean, always present on a round minted by `createBoard` or `addRound`: `true` when the
round carries a question block anywhere in it (top-level, or nested in a question's
`context` or a `compare` side), or when it is a page board — one `html` block and nothing
else (ADR 33) — posted with `wait: true` (`POST /api/board`, below). It is the one property
behind three surfaces: it is what makes a round sendable at all beyond ADR 35's carve-out,
what the index's "N rounds left" badge and the tab mark count, and what gates the SSE
arrival mark and the daemon's Stranded banner. `awaitDeadline` is `null` when `awaited` is `false`, otherwise the ISO
8601 instant `postedAt` plus the wait timeout in effect when the round was minted (default
40 minutes, `CLAUDE_BOARD_TIMEOUT_MS` — the same clock `GET /api/board/:id/wait` enforces,
below) — stamped at mint time and never recomputed by an amend of the same round.
`wait: true` on a round that already carries a question is **ignored, not refused**: the
round is awaited by its question either way and the deadline is identical either way, so
the flag asks for the state the round is already in. It stays the two routes above; `wait`
never becomes a third.

**`awaited` comes back off when the deadline passes** (ADR 50). `closeLapsedAwaitedRounds`
(`src/badge.mjs`) is the only writer that clears it, and `readBoard` (`src/store.mjs`) — the
choke point every reader of a stored board goes through — applies it on every read, so a round
whose wait has died reads back `awaited: false` without any surface needing a clock of its own.
`awaitDeadline` is deliberately left in place as the record of when the wait died; `status`
is not touched either, so a lapsed round is `{ status: 'open', awaited: false }` and the
deadline is what distinguishes it from a round that was never awaited at all. The flip is
persisted opportunistically (the daemon's own `/wait` timeout branch writes it; otherwise it
rides the board's next write), so a reader may see it before disk does — never the reverse.
`amendRound` never touches either field: a round is only ever amendable while it already
carries a question (see `POST /api/board` below), which means it was already `awaited: true`
the moment it was minted. **A round persisted before this pair of fields existed carries
neither key at all** (`undefined`, not `false`) — `roundIsAwaited(board, round)`
(`src/badge.mjs`) is the one shared predicate every reader of `awaited` uses instead of a bare
field read, precisely for this case: it reads `r.awaited` directly when it is a real boolean,
and for exactly a legacy round falls back to the old shape-based inference (a question block
anywhere in the round) that decided the same question before this pair of fields existed. The
undelivered-comment drain path (`src/server.mjs` `drainUndeliveredComments`), the index badge
and tab mark (`src/indexpage.mjs` `openAwaitedRounds`), and the SSE arrival favicon mark
(`src/ui.mjs` `markPendingRound`, spliced from the same `src/badge.mjs` source) all read it —
one definition, so a board already on disk keeps its exact prior behaviour on every one of
these surfaces rather than any single one of them reading a legacy round as suddenly
unawaited.

### Blocks

Every block has `{ id, round, kind }`. Content blocks additionally carry the resolved snapshot —
`text` (`html`, for an `html` block) and `sha` — written once at post time and never re-read.

```js
{ kind: 'markdown', source: Ref|null, text, sha, html, anchors, error? }
{ kind: 'mermaid',  source: Ref|null, text, sha, error? }
{ kind: 'code',     source: Ref,      text, sha, lang, error? }
{ kind: 'html',     source: Ref|null, html, sha, error? } // path-only source: `lines`/`section` refused
{ kind: 'compare',  left: { label, block }, right: { label, block } }
{ kind: 'question', prompt, context: [ContentBlock], widget, options: [Option] }

Ref    = { path, section?, lines? }               // lines is [from, to], 1-based inclusive
Option = { label, description?, preview? }                  // every widget except the one below
       | { label, description?, block: ContentBlock|null }  // widget 'choose-between-rendered-variants' only
widget = 'single' | 'multi' | 'text' | 'rank' | 'choose-between-rendered-variants'
```

A markdown block's `anchors` is markdown's own slug index for headings and top-level list items
(`kind: 'md'`, `ref`, `label`) — stored state that backs the `id` attributes in the emitted HTML,
and a different vocabulary from the comment `Anchor` below.

**`error`**: when a block carries `source` and `src/resolve.mjs` fails to resolve it (missing
file, out-of-range lines, section not found), the block is still minted and kept — `text`
(`html`, for an `html` block) comes back `''` and `sha` the hash of the empty string — with
`error` set to a human-readable reason, which the page renders in place of the content. Nothing
is dropped and the post does not abort. A block with no `source` never sets `error`.

**`html` may carry a `source`** (ADR 7), for an agent that renders a real page to disk rather
than re-emitting the bytes as generated tokens. It resolves through the same reader, confinement,
512 KiB cap and block-level `error` behaviour as `markdown`, `code` and `mermaid`. It is the one
exception to what a `Ref` may carry: `lines` and `section` are refused with a block-level `error`
naming markup slicing as the reason. Cutting text at a line boundary still yields text; cutting
markup yields unclosed tags and orphaned `<style>`.

**A widget outside the union is a 400**, not a silent fallback to `single`: an unrenderable
widget produces a question with no control, which Send then reports back as `unanswered`, so the
agent misreports an unanswerable question as "the reviewer left it blank". A
`single`/`multi`/`rank`/`choose-between-rendered-variants` question with zero options is a 400 for
the same reason; `text` needs none.

**`choose-between-rendered-variants`** is the one widget whose options are not `{ preview }`
strings: each option's `block` is a real content block of any kind, normalized the same way a
`compare` side's own `block` is — same `normalizeBlock`/`resolveBlockId` path, the same shared id
ledger a post's other blocks compete against, so it mints a real, unique block id rather than an
inert string, and renders through the same dispatch. The answer shape does not change: `choice` is
still the picked option's `label`, a plain string, identical to `single`.

An option's `html` stage is rendered non-interactive (`pointer-events: none`), so a click over the
visible mock reaches only the card around it, which is the sole thing that can record a pick
(`SECURITY.md`). One consequence: an `html` option's element-level comment-anchor gesture is
unreachable too, the way its click is; a `mermaid` option's is not, since a diagram renders inline
with no iframe. The whole-block comment control renders in the parent document,
so an `html` or `mermaid`
option still carries one regardless of the iframe.

No caller in this repo posts this widget; `/example`, which ships outside this repo (ADR 5), is
its real caller.

**`cwd` is bound once, per thread.** `cwd` is the board's own project directory, and one of the
two places a reference may resolve — the other being the configured reference roots below. It is
the only one of the two a *caller* chooses, and confinement is vacuous if a later post can move
it, so it is accepted only on the post that creates the thread, and validated there (a **400**):

```
relative                             refused: it would resolve against the daemon's own cwd
not an existing directory            refused
the filesystem root                  refused
$HOME, or any directory above it     refused: every project at once, plus keys and history
```

The value stored is the **realpath**. A post carrying `boardId` may repeat the board's own `cwd`
but may not change it; a post naming an existing `thread` inherits that thread's directory, looked
up **server-side** from the oldest board in the thread and passed to `createBoard` as `threadCwd`,
and may not change it either — a different `cwd` there is a **400** (`cannot retarget thread: ...`)
and creates nothing. A board with no `cwd` resolves no references at all; it never falls back to
the daemon's own working directory.

**Reference confinement and caps** (ADR 3). A `Ref.path` names a file *inside the board's `cwd`,
or inside one of the configured reference roots*, and nothing else. Every violation is an `error`
on the block — never a throw, never a read:

```
absolute path                        refused unless it lands inside a reference root
realpath outside cwd and every root  refused (covers ../ traversal AND symlinks out)
the project directory itself         refused: a directory is never a reference target
not a regular file                   refused (a fifo blocks the daemon's only thread
                                      forever; a character device exhausts its heap)
larger than 512 KiB                  refused, before any of it is read
line range past end of file          refused at BOTH ends (a trailing newline does not
                                      make a phantom last line)
```

The last three are decided on the **open file descriptor**, not on the path a second time: a
reference is opened exactly once, refusing to follow a symlink in any component while it does.
Which refusal comes back is decided only on names inside the boundary — a reference that does not
resolve inside it reports the same thing whether its target is absent, unreadable or simply
elsewhere, so a refusal is never an existence probe for the rest of the disk.

The reference roots are `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths), so a session can
render the skill, command or agent file it is discussing, and reference a page it has just rendered
to disk rather than inlining it. The default `install.sh` writes into the launchd plist is exactly
four directories: `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents` and
`~/Documents/renders`. An *absent* variable means no allowlist at all — the `cwd`-only boundary —
so that a default living in code cannot widen the boundary on a machine that never reinstalled; an
explicitly empty value means the same. Each root is validated exactly as `cwd` is above, with
`$HOME` decided on `dev`+`inode` rather than on spelling since macOS gives it several equally
canonical paths. A root failing any of that is dropped rather than widened or fatal, and a spec
that cannot be parsed as written (an entry that is not an absolute path, which is what a directory
name containing `:` degenerates into) grants nothing at all.

A markdown `section` is located with the same fence-aware scan `src/markdown.mjs` uses, so the
slug the agent is shown for a heading is the slug that resolves.

The same 512 KiB cap applies to by-value `text` and `html`, where it is a **400 on the post**
rather than a block-level `error`: by-value content came from the caller, so there is a caller to
tell. A `source` ref never raises this cap for any kind — the whole file's size is checked from
`fstat` before any of it is read.

### Answers, comments, anchors

**Commentable.** Only the rendered kinds are — `mermaid` and `html` — and they are wherever they
appear, including inside a question's `context` and inside a `compare` side. `markdown` and `code`
are not, anywhere. The rule is drawn on kind, never on position (ADR 28, which supersedes the
comment half of entry 26 and narrows entry 28).

```js
Answer  = { id, status, choice, note }
          // status: 'answered' | 'unanswered' | 'deferred'
          // choice: string (single, text) | string[] (multi) | string[] ordered (rank) | null
          // note is always present, '' when empty. unanswered is explicit, never a default.

Comment = { n, blockId, anchor, text, createdAt, round, mintBlockKind }
          // mintBlockKind is the target block's kind at mint time, so an amend that
          // replaces a block with a different kind cannot silently re-point the anchor

Anchor  = { kind: 'block' }                       // whole block
        | { kind: 'dom',     ref, hint }          // "N.N.N" child-index path + a composed hint
        | { kind: 'mermaid', ref, domRef, hint }  // node id, plus the same path + hint; ref is
                                                  // the fallback, never the model. domRef/hint
                                                  // are absent on older stored anchors
```

`src/board.mjs`'s `ANCHOR_KINDS` no longer admits `md` (ADR 28). An `md` anchor stored by an older
client degrades to a whole-block comment, the same fallback an unrecognised kind always got.

An anchor of any kind that no longer resolves at render time is reported, not dropped: the comment
survives with `resolved: false` and a `lost` field naming what it lost (`src/board.mjs`'s
`lostLabel`) — the stored `hint` when there is one, the bare `ref` otherwise.

A `dom` ref's index chain is 1-based over `Element.children` **as the browser parses the markup** —
implied `tbody`, auto-closed `p`/`li`/`tr`/`td`/`option`, and `script`/`style` counted as elements.
`src/ui.mjs` mints it against the live DOM and `src/anchor.mjs` resolves it against the snapshot;
the two trees have to agree node for node or a live element reports lost.

A `dom` anchor's root depends on which block it names: for an `html` block, that stage's sandboxed
iframe body (`resolveDomAnchor`); for a `mermaid` block's own chrome — anything but a diagram node
itself, which mints a `mermaid`-kind anchor instead — the block's own `<section data-block-id>`,
re-rendered from its stored content and resolved by `resolveDomAnchorInSection`. `src/ui.mjs`'s
`ANCHORABLE_BLOCK_KINDS` names only `html` and `mermaid`, so a click on a paragraph or a code line
never reaches the gesture at all, and a stage or diagram nested in a question's `context` or a
`compare` side is exactly as anchorable as one at the top level.

**A `question` or `compare` section is never a `dom` anchor root.** Those two kinds render no
content of their own — a card around a widget, a grid around two nested blocks — and carry no
comment area, no pin layer and no gesture; `src/ui.mjs` refuses the root by `data-block-kind`
before minting. What is nested inside them is unaffected, and is a root in its own right when its
own kind is `html` or `mermaid`.

`hint` is composed, not a bare snippet. `composeHint` (`src/anchor.mjs`, mirrored client-side in
`src/ui.mjs`) starts from the clicked element's own text, falling back to a role word (`button`,
`link`, `field`, `image`, `menu`) for role-bearing tags with none, or the tag name for anything
else empty. Only inside one side of a `compare` does it go further: the role word is appended after
real text too (`"Send button"`), and the identity is suffixed with `" in <context>"`, naming that
side's label plus the block kind it holds (`"Before html stage"`, `"After diagram"`).

### A complete board

Two rounds. Round 1 carried a `markdown` reference and a `question` whose `context` holds a
referenced `html` stage; it was sent, with the question answered `deferred` *and* carrying a
`choice`, plus one comment anchored to an element inside the stage. Round 2 is open and carries a
`compare` of two by-value diagrams. Emitted by `createBoard`/`applySubmit`/`addRound`, unedited
except for `cwd`.

```json
{
  "id": "b_1d20d4f6aba431c531fa220425617217",
  "thread": "th_89521123",
  "title": "fix/session-timeout",
  "cwd": "/Users/you/projects/api",
  "createdAt": "2026-08-06T20:16:35.032Z",
  "updatedAt": "2026-08-06T20:16:35.034Z",
  "state": "open",
  "rounds": [
    { "n": 1, "postedAt": "2026-08-06T20:16:35.032Z", "status": "sent",
      "sentAt": "2026-08-06T20:16:35.034Z", "title": "fix/session-timeout",
      "action": "submitted", "awaited": true, "awaitDeadline": "2026-08-06T20:56:35.032Z" },
    { "n": 2, "postedAt": "2026-08-06T20:16:35.034Z", "status": "open",
      "sentAt": null, "title": "fix/session-timeout", "awaited": false, "awaitDeadline": null }
  ],
  "blocks": [
    {
      "round": 1,
      "id": "d1",
      "kind": "markdown",
      "source": { "path": "docs/auth.md", "section": "open-questions" },
      "text": "## Open questions\n\nShould the session survive a daemon restart?\n",
      "sha": "328b01d3c82bbaeedda1616fbdb1f6818eb546e425891d6515eb122690e8bde7",
      "html": "<h2 id=\"open-questions\">Open questions</h2><p>Should the session survive a daemon restart?</p>",
      "anchors": [ { "kind": "md", "ref": "open-questions", "label": "Open questions" } ]
    },
    {
      "round": 1,
      "id": "q1",
      "kind": "question",
      "prompt": "How long should an idle session live?",
      "context": [
        {
          "round": 1,
          "id": "h1",
          "kind": "html",
          "source": { "path": "renders/timeout.html" },
          "html": "<p>Session expired.</p>\n<button>Retry</button>\n",
          "sha": "50a43eee3656a72c172495a4b3c4e5e0b67e2434cf5a82da3d38f282b321459d"
        }
      ],
      "widget": "single",
      "options": [
        { "label": "30 minutes", "description": "Matches the old behaviour.", "preview": null },
        { "label": "24 hours", "description": "Survives a lunch break.", "preview": null }
      ]
    },
    {
      "round": 2,
      "id": "x1",
      "kind": "compare",
      "left": {
        "label": "Before",
        "block": {
          "round": 2, "id": "m1", "kind": "mermaid", "source": null,
          "text": "graph LR; A[idle] --> B[logout]",
          "sha": "a787bfa1e03cf424430625acf41c3bb9329474e070e78687ab334ed3c80696cf"
        }
      },
      "right": {
        "label": "After",
        "block": {
          "round": 2, "id": "m2", "kind": "mermaid", "source": null,
          "text": "graph LR; A[idle] --> B[warn] --> C[logout]",
          "sha": "e5e5150b8dd1a68a878ed7dc22fc8d74cb2e87bcdf87185fe67361a80ee0db58"
        }
      }
    }
  ],
  "answers": {
    "q1": {
      "id": "q1",
      "status": "deferred",
      "choice": "24 hours",
      "note": "Leaning this way; check with ops first."
    }
  },
  "comments": [
    {
      "n": 1,
      "blockId": "h1",
      "anchor": { "kind": "dom", "ref": "2", "hint": "Retry button" },
      "text": "This should say \"Sign in again\".",
      "createdAt": "2026-08-06T20:16:35.034Z",
      "round": 1,
      "mintBlockKind": "html"
    }
  ]
}
```

## Packet — what the `ask` tool returns

```js
{
  board, thread, title, round,
  status,                           // 'posted' | 'submitted' | 'discuss' | 'timeout' | 'error'
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, resolved, lost? } ],
  url,
}
```

`posted` means the round was not *awaited* (`round.awaited`, CONTEXT.md "Awaited"): it carried
no question block anywhere in it — top-level, or nested in a question's `context` or a `compare`
side — and it was not a page board (one `html` block, nothing else) posted with `wait: true`
(ADR.md entry 45) — so there was nothing to submit and the shim returned the instant the post
succeeded rather than waiting at all. `answers` and `comments` are always empty on a `posted`
packet. `discuss` means the reviewer chose Discuss in chat: partial answers
are included and the agent must stop posting boards for the rest of the session. `timeout` is the
wall-clock cap (default 40m, ADR.md entry 47) and carries an explicit no-response — an empty `answers`, and no
comments beyond the undelivered ones described next, which are owed to a timed-out round exactly
as they are to any other.

**Scope: one packet is one round, with one exception.** `answers` holds exactly the question
blocks whose `round` is the packet's `round`, and `comments` exactly the comments left in it.
Round 6 does not redeliver rounds 1-5: the agent would re-address settled feedback and re-report
an old `unanswered`/`deferred` as a fresh signal, louder each round. Every entry carries its own
`round` (and each comment its `createdAt`), so a caller that wants the thread's history reads
`board.answers` / `board.comments`. The stored board keeps everything; the packet is the round.

**The exception: a comment left on a round that is not *awaited*** (ADR.md entry 35, narrowed by
entry 45). A page board posted without `wait: true` is a round nothing ever waits on, so nothing
would otherwise carry its comments back — the reviewer's feedback on the artifact would sit in the
store unread. Such a comment rides the next packet the same thread returns, once, appended to that
packet's own `comments`; it carries its own `round`, which is how a caller tells it from the round
in hand. Once, not once per round: the packet is committed as delivered only after the response
has actually left, so a dropped connection re-delivers rather than loses, and a delivered comment
is never sent again. Collecting comments from a page board therefore costs either `wait: true` on
it, so it gets its own `/wait` call and its own `submitted` packet with `comments` populated
directly (an empty array there is a normal outcome, not this exception), or a later round that
asks something — an agent that wants them one way or the other rather than polling for it.

**`status` is the only thing that says whether a question was decided; `choice` is not.** A caller
must branch on `status` and never on `choice` being non-null, because the three statuses do not
agree about `choice`:

- `answered` — `choice` holds the answer.
- `deferred` — `choice` may ALSO hold a selection. The reviewer can pick an option and still mark
  it "revisit later", and that tentative lean is worth carrying rather than discarding. A caller
  that reads `choice` alone therefore records a decision the reviewer explicitly declined to make.
- `unanswered` — `choice` is `null`.

`answers` covers **every** question block of that round, including ones nested in another
question's `context` or in a compare side — the renderer makes those live widgets and the page
submits them, so dropping them would lose an answer the reviewer actually gave. An answer whose id
is not a question block of the round being submitted is ignored server-side rather than stored.

## HTTP surface

```
GET  /?q=                           thread index, filtered to sessions matching q
GET  /b/:boardId                    the served page
GET  /api/health                    { ok: true, version }        (open: install.sh polls it)
GET  /auth/:token                   consume a handoff -> 302 + Set-Cookie  (open by necessity)
POST /api/handoff                   { boardId? } -> { token, expiresAt, ttlMs }
POST /api/board                     post a board or a round into a live thread
                                    -> { boardId, thread, round, url, clients, awaited }
GET  /api/board/:id/wait?round=N    blocks until the round is sent -> Packet
GET  /api/board/:id/events          SSE: round pushes, state changes
POST /api/board/:id/submit          { round, action: 'send'|'discuss', answers, comments }
POST /api/board/:id/attended        { watcher, attended, seq? } -> { ok: true }; the open
                                    tab reporting whether it is Attended right now
                                    (CONTEXT.md "Watcher", "Attended"); stores nothing
                                    durable itself, but a report that ends an absence
                                    retires the stranded banner recorded on that board
GET  /api/search?q=                 archive search
GET  /api/pomodoro                  the whole document -> { settings, cycle, cycleDate, timer, now };
                                    rolled to the current pomodoro day first, so a read
                                    never shows an interval from a day that has ended
POST /api/pomodoro/ensure           ensure a timer exists; no-op if one already does (any
                                    phase) from the CURRENT pomodoro day; against a document
                                    left over from a previous one it rolls the day and starts
                                    a fresh work interval, in the one call
POST /api/pomodoro/pause            freeze the running interval
POST /api/pomodoro/resume           continue a paused interval from where it froze
POST /api/pomodoro/reset            end the loop: timer -> null, cycle -> 0
POST /api/pomodoro/forward          end the current interval now and begin the next phase,
                                    with the exact bookkeeping a natural boundary performs;
                                    no-op while idle; fires no notification and no cue
POST /api/pomodoro/restart          re-mint the current interval's deadline to a full phase
                                    duration (current settings); phase/cycle untouched;
                                    no-op while idle; fires no notification and no cue
POST /api/pomodoro/settings         { workMin?, breakMin?, longBreakMin?, longEvery?, notify?,
                                    notifyRounds?, cueWork?, cueBreak?, cueLongBreak? }
                                    merged into the stored settings, not replaced
POST /api/pomodoro/preview          { cue } -> { ok: true }; plays a cue immediately, reads
                                    and writes nothing
POST /api/pomodoro/notifyTest       no body -> { ok: true }; raises one test banner
                                    immediately, reads and writes nothing
```

Posting and waiting are separate routes on purpose, so splitting `ask` into post + collect stays
cheap.

**Four gates, in order:** loopback `Host` (403), same-origin on every non-GET (403), a credential
on every non-GET (401), a credential on every GET but two (401). Both credential gates are written
as "everything, minus an explicit exception list", so a route added later is gated by default
rather than by whoever adds it remembering.

The Host check does not cover a browser: a page on any origin doing
`fetch('http://127.0.0.1:7391/...')` has its `Host` set to loopback by the browser itself. So
every non-GET additionally refuses (403, no body) when `Origin` is present and is not the daemon's
own origin, or when `Sec-Fetch-Site` is present and is not `same-origin`, and every body must be
`Content-Type: application/json` (415 otherwise). Non-browser clients (the shim, curl, the checks)
send neither header and are unaffected. Every HTML response also carries `X-Frame-Options: DENY`
and a `frame-ancestors 'none'` CSP.

### The local secret

```
~/.config/claude-board/secret      0600, in a 0700 directory; 32 random bytes as hex
                                   generated by install.sh, NEVER rotated by a reinstall
                                   (CLAUDE_BOARD_SECRET_FILE relocates it, for the checks)
x-claude-board-secret: <secret>    request header; the file is re-read per gated request,
                                   which is what makes rotation revoke; compared with
                                   crypto.timingSafeEqual, length-guarded
```

**Every non-GET request** must carry it — except `POST /api/board/:id/submit` and
`POST /api/board/:id/attended`, which also take the session cookie below. A missing or wrong
credential is **401 with no body**: nothing about
what is behind it, not even whether the board exists. A daemon that finds no secret file says so
on stderr at startup and refuses everything gated: it fails closed, never open. `bin/mcp.mjs`
reads the secret at startup, sends it on every call, and refuses to post at all (naming
`./install.sh`, writing nothing) when it has none or the daemon answers 401. `SECURITY.md` carries
why a local secret exists at all.

### The browser session cookie

**Every route but `GET /api/health` and `GET /auth/:token` requires a credential**, reads
included. The browser cannot read a 0600 file, so it holds this instead:

```
Set-Cookie: cb_session=<HMAC-SHA256(secret, "claude-board/session/v1")>;
            Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict
```

Host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, and **not** a session cookie: a bookmarked
board opened days later has to work. No `Secure`, and none is possible — the daemon serves plain
http on loopback, so a `Secure` cookie would never be sent back.

**Derived from the secret, not random**, which is what makes it survive a daemon restart: any
daemon holding the same secret accepts the same cookie, so `launchctl kickstart`, a crash and a
code reload are all invisible to an open browser. Rotating the secret invalidates every browser at
once — intended.

Its strength, precisely: "may read every board and answer any open round". It is refused in the
`x-claude-board-secret` header, so it can never create a board and therefore never make the daemon
resolve a file. It is **not** scoped to one board.

It is additionally accepted on `POST /api/board/:id/attended` — a browser holding the cookie is the
only party that can honestly report whether its own tab is Attended, and the report reaches less
than `submit` already does: no round named, no answer carried, nothing durable touched (see that
route's own section, below).

It is additionally accepted on nine pomodoro writes — `ensure`, `pause`, `resume`, `reset`,
`settings`, `preview`, `notifyTest`, `forward`, `restart` — so the index page's switch and its
settings popover can drive the clock. That clock never touches a board, never gates an `ask` and
never reaches a tool, so it costs the cookie nothing it did not already carry. The
list stays a closed, named set: a pomodoro write added later is secret-only until someone
deliberately names it.

### Authorizing a browser

A credential never appears in a URL a bookmark can capture. Instead:

```
POST /api/handoff       { boardId? }  (secret required)  -> { token, expiresAt, ttlMs }
GET  /auth/<token>      302 -> /b/<boardId> (or /), Set-Cookie: cb_session=…
```

`POST /api/handoff` mints a **single-use, ~30s** token (`CLAUDE_BOARD_HANDOFF_TTL_MS` overrides,
for the checks). It takes the secret only — the session cookie is refused here, so a browser
cannot mint itself a second credential. The caller names a *board*, never a path: anything that is
not a board id redirects to the index, so there is no attacker-chosen redirect target to validate.

`GET /auth/<token>` consumes it, sets the cookie, and redirects to a **clean** URL. Expired,
already used, and never existed are one indistinguishable refusal. The token is process-local, so
it does not survive a daemon restart — the opposite of the cookie it hands out, deliberately. The
shim opens the tab on a handoff URL rather than a board URL, rebuilding that URL from its own base
URL and the returned token rather than trusting anything in the response body.

`node bin/authorize.mjs` (`npm run authorize`) is the recovery command: it mints a handoff and
opens the browser. `--print` emits the URL instead, for a second profile or a different browser;
an optional board id argument lands on that board rather than the index. `src/handoff.mjs`
`recoveryCommand()` is the single source of that string.

### Refusing a caller with no credential

**401, one status code everywhere.** No `WWW-Authenticate` header: it would raise a browser
password prompt in front of the page that explains the actual fix, and there is no password to
type.

A **browser navigation** (a path outside `/api/` whose `Accept` includes `text/html`) gets an HTML
page naming the recovery command verbatim. Everything else — `/api/*`, the SSE stream, curl, the
shim — gets `{ error, recover }` as JSON and no markup. Neither reveals anything about the store:
the same page is served whether or not the board exists.

### `POST /api/board`

`{ title, blocks, cwd?, thread?, wait? }` starts a new thread; `{ boardId, blocks, title?, wait? }`
pushes into a live one. `cwd` is only meaningful on the thread-creating form. `title` is meaningful
on **both**: on the `boardId` form it labels the round being minted or amended. `wait` (boolean,
default `false`) is meaningful only on whichever call actually MINTS the round being posted — an
amend never mints one, so `wait` on an amending post is inert (the round it would apply to was
already stamped `awaited` when it was first minted, per the paragraph above naming
`awaited`/`awaitDeadline`). It sets `round.awaited` together with the question-block check
already run on the same blocks: see "Round `awaited` / `awaitDeadline`" above.

Pushing into a live board **amends** the latest round in place — a block whose incoming id
already exists on the board replaces it, everything else is appended to that same round — while
that round is still `open` **and carries a question block somewhere in it**. Otherwise it mints a
new round. Either way the response is `{ boardId, thread, round, url, clients, awaited }`, `round`
naming whichever round was amended or minted and `awaited` carrying that round's own minted
`awaited` flag. The flag is on the response because the poster cannot always compute it: the shim
checks the raw blocks it sent and has no way to know that an `html` block's `source` failed to
resolve, which is exactly the case where the daemon mints the round *not* awaited. A caller
deciding whether to wait should prefer this field and fall back to its own shape check only when
it is absent (a daemon older than this field).

A **retry** carrying a `requestId` this board has already applied is answered from what that id
already did (`deduped: true`) while the round it guarded is still `open` **and its wait has not
lapsed**. A round whose `awaitDeadline` has passed can never hand a caller a packet again, so it is
never the answer to a retry: the post falls through and mints the next round, against a live
deadline.

The question is what makes a round amendable, because amending exists for one situation: the agent
is still assembling a round the reviewer has not answered yet. A round that asks nothing is
complete the moment it lands — nothing can ever answer it, so it stays `open` for good — and a
later post is a new round beside it, not an edit of it. That is what makes "post the artifact,
then ask about it" two rounds, and therefore two pages one flip apart.

A board can consequently hold **two open rounds at once**: an artifact round nobody will ever send,
and the question round after it. Wherever this protocol says *the open round* — the round a submit
must name, the round an amend lands on — it means the **latest** open one.

### `POST /api/board/:id/submit`

```js
{
  round: 1,                                       // required; must be the open round
  action: 'send' | 'discuss',
  answers:  [ { id, status?, choice, note? } ],   // status defaults to 'answered' when
                                                  // choice is present, 'unanswered' otherwise;
                                                  // any question block with no entry here is
                                                  // synthesised as unanswered server-side
  comments: [ { blockId, anchor, text } ],        // n, createdAt, round assigned server-side
}
```

`round` names the round the page believed was open when the reviewer pressed the button. Omitting
it is a **400**; naming any round other than the currently-open one is a **409** whose body carries
`{ error, board, round }`, `round` naming the round that IS open (`null` when none is). Without it,
a second tab — or a plain double-click, since the send bar sits outside the round section and so is
never disabled by the history collapse — appends the same comments a second time under fresh
numbers and re-applies answers to a round that already went out. A 409 means "already sent" and is
not an error state.

`action` is the whole difference between the two ways out of a round, and the body is otherwise
identical, because `discuss` is defined as returning *whatever is filled in*, not a degraded
second path:

- `'send'` → `board.state = 'submitted'`, packet `status: 'submitted'`.
- `'discuss'` → `board.state = 'discuss'`, packet `status: 'discuss'`; partial answers are
  included and the calling agent must stop posting boards for the rest of the session.

The page renders both as buttons in one `.send-bar` (`#send-btn`, `#discuss-btn`), which
`body.readonly` hides wholesale — so the standalone `file:` archive offers neither.

### `POST /api/board/:id/attended`

```js
{ watcher: '<id from the stream's own "watcher" event>', attended: true | false, seq?: 0, 1, 2… }
  -> { ok: true }
```

The open board tab reporting whether it is Attended (CONTEXT.md "Watcher", "Attended") — visible
and focused, right now. `watcher` names which SSE connection (`GET /api/board/:id/events`) this
report updates; a `watcher` the daemon has no live subscription for, or a board id with none at
all, is a silent no-op rather than a 404 or a 400, since the tab has no way to know from its own
side whether it lost that race against a disconnect.

`seq` is the page's own monotonic counter for the edge being reported, and reports that arrive out
of order are dropped rather than applied. They can arrive out of order: a focus and a blur ~100ms
apart are two POSTs, and the browser opens a second connection for the later one while the first is
still outstanding. A blur overtaken by its own earlier focus would otherwise leave the Watcher
marked attended with the reviewer gone, and no further DOM edge is coming to correct it — so the
board would raise no banner for the rest of that wait. It is optional, and a report without one is
applied and leaves the counter alone, so a page predating the ordering keeps working; present and
malformed is a 400.

Cookie-authenticated exactly like `submit` (see "The browser session cookie" above): a browser
holding a live stream on this board is the only party that can honestly answer this question, and
an unauthenticated report is refused rather than believed — accepting one from any local process
with no credential would let a forged report silence every banner the daemon would otherwise raise
(ADR.md entry 58).

What it stores is a fact about a live SSE connection and nothing about the board. It is not,
however, a route with no durable consequence: the stranded rule reads that fact immediately, and a
report that ends an absence retires the banner record standing on the board — one read and one
write, and for a page board that document can be large. That is the price of a marker that survives
a restart, and it is paid only when the reviewer really comes back to a board that had been
announced; the ordinary report writes nothing. A report naming a `watcher` this board has no live
subscription for stops before the rule is consulted at all.

The daemon ORs this flag across every Watcher currently subscribed to a board — two tabs on it
count as looking if either one does — and the flag is held only as long as its SSE connection is:
closing the tab (or the connection dropping) removes it, which is what makes "a tab that goes away
stops counting" true with no separate timeout.

A Watcher that has subscribed but not yet reported is **unknown**, not attended: it holds a banner
back (a tab that has only just connected is what a reconnect looks like) but it does not count as
the reviewer having come back, so it cannot end an absence. The page closes that gap in one round
trip — it reports the moment the stream hands it a `watcher` id — but the distinction is
load-bearing: without it, a buried tab's reconnect would clear the announced marker off a board
nobody had looked at, and that tab's own "still hidden" report a moment later would announce the
same absence a second time. Nor does an unreported Watcher hold a banner back: the stranded rule
asks only whether one has *said* it is looking, so holding `/events` open and saying nothing — which
needs only a read credential — cannot mute a board. A tab that drops and reconnects inside the grace
is silent because it reports, not because its socket exists.

### The stranded banner

The daemon raises one native notification for a board that has an open, awaited round on it and no
Watcher looking at it (CONTEXT.md "Stranded"; ADR.md entries 55 and 58). It is re-decided after
every event that can change the answer — a round landing, a Watcher arriving or leaving, an
`attended` report, a submit — never polled, and it fires after a grace of 15000ms
(`CLAUDE_BOARD_STRANDED_GRACE_MS` overrides, and the launcher passes it through), which is one SSE
heartbeat, so a tab that is merely reconnecting is never mistaken for an absent reviewer.

One banner per **board**, per absence: further rounds landing on a board whose announced round is
still awaited add nothing. The click carries the board's own URL plus the `#stranded-round`
sentinel, which resolves to the oldest round still waiting at the moment it is clicked (not
`#open-round`, which resolves to the newest open round and belongs to the index's live-row links).
The URL is built from the socket the daemon is bound to and never from the `Host` header, and the
bound port crosses to the launcher as its own argument so the two can be checked against each
other.

The banner is recorded on the board document as `strandedBanner`,
`{ at, until, round, pid } | null`: when it went up, when the process serving it will exit and
withdraw it (the round's deadline or the launcher's hard ceiling, whichever is sooner), which round
was announced, and that process's pid. It is stripped from everything a client sees, so the served
page stays byte-identical to `pages/<id>.html`. A daemon restart reads it back and does not
re-announce.

An absence ends exactly two ways: the reviewer returns (a Watcher *reports* it is looking), or the
round named in `round` stops being awaited — answered, or its wait lapsed — whereupon the next round
on that board starts a fresh absence and may raise a banner of its own. Both are read lazily off
events the daemon already handles; there is no timer on `awaitDeadline`.

A daemon restart is neither, on either path. Killed outright, the daemon leaves its child orphaned
with the banner still up and the record on disk. Stopped gracefully, it SIGTERMs the child — so the
banner goes off the screen — and leaves the record standing with only its `pid` cleared, since that
pid now names a process it has just killed. Both mean the same thing to the successor: this board's
absence has been announced, and nothing more is raised for it until the reviewer comes back.

Nothing else ends it. In particular a banner that has expired off the screen still counts as this
board's one announcement while the round it named is awaited, so **a reviewer who dismisses a banner
without opening the board is told nothing further about it until that round's wait ends**. That is
criterion 7 read literally, and it is a deliberate trade: the alternative raises a second banner for
an absence the reviewer never came back from.

The daemon owns the process serving the click and kills it with SIGTERM — which is also what
withdraws the delivered banner — when the reviewer returns, when **the round the banner is about** is
answered (a board can hold two awaited rounds at once, and answering the other one leaves the banner
alone), and unconditionally when the daemon itself stops. The recorded pid lets a replacement daemon withdraw a banner it did not raise;
that is the one thing `until` is consulted for, since past it the child has exited and its pid has
been recycled. Signalling additionally requires that the pid is neither this process nor its parent,
that it is that executable, and that it started no earlier than the record did. The parent check is
the load-bearing one: the same path names every claude-board process, the supervising launchd job
included, SIGTERM to that one is relayed to the daemon, and a supervisor started by a restart is
*newer* than the record, so the start-time test does not exclude it.

### `GET /api/board/:id/wait?round=N`

A server-side wall-clock ceiling matching `CLAUDE_BOARD_TIMEOUT_MS` (default 40m, ADR.md entry 47): when it fires
the call returns 200 with a packet whose `status` is `timeout`, carrying whatever partial answers
the store holds. A client that disconnects ends the wait outright — nothing is written and the
poll stops.

### The pomodoro routes (ADR 8, 20, 67)

Everything the table above does not say:

- **The pomodoro day runs 05:00 to 05:00 local** (ADR 67), and the document's `cycleDate` names
  which one it belongs to — the day's own date, so an interval running at 01:00 is still stamped
  with yesterday's. Crossing that boundary is a **rollover**: the whole loop ends, `timer` to
  `null` and `cycle` to `0`, the same clearing `reset` performs. Midnight is not a boundary, so a
  session worked past it keeps the pomodoros it has banked; nothing else ages a timer, so a pause
  at 09:00 resumes intact at 16:00. The hour is a constant in the source, not a setting.
  The rollover is applied **lazily**, by whatever next touches the document — every read included
  — so there is no scheduled job and nothing has to run while the machine is asleep. A read
  applies it to what the caller gets and writes nothing; the next write is what carries the
  rolled shape back to disk.
- `GET /api/pomodoro` returns the whole document (`src/pomodoro.mjs` `defaultDoc`) plus `now`, the
  daemon's own `Date.now()` at response time, so the page computes `serverNow - Date.now()` once
  and keeps subtracting that offset rather than trusting the browser's clock against a
  server-minted deadline. Every write route returns the same `{ ...document, now }`, reflecting
  the state immediately after that write — except `preview` and `notifyTest`, which return
  `{ ok: true }`.
- `ensure` is *ensure*, never *start*: a running, paused or mid-break timer **from the current
  pomodoro day** is left untouched, so a second session, a `/clear`, a resume or a session in
  another project is a no-op and starting mid-break does not cut the break short. A timer from a
  day that has ended is not one of those: the morning's first session rolls the day *and* starts
  a fresh work interval in the one call, so nobody has to clear last night's pause by hand. It is
  deliberately callable with **no body at all** — `readJsonBody` is never invoked on it — so a
  one-line `curl -X POST` from a shell hook works.
- `pause` converts the running interval's absolute `deadline` into a `remainingMs` snapshot and
  sets `paused: true`; `resume` reverses that (`deadline = now + remainingMs`), so the interval
  continues from where it froze rather than restarting. Both are no-ops where they make no sense.
- `forward` and `restart` both unpause a paused timer into a running one. `forward` applies
  `settleBoundary`'s own advance rule rather than a second bookkeeping path beside it, so a
  forwarded work interval still earns its break, a forwarded break still increments `cycle`, and a
  forwarded long break still resets it.
- `settings` **merges** a partial patch rather than replacing, and validates at this trust
  boundary: every duration and `longEvery` a finite integer in a sane range (`longEvery` at least
  1 — `settleBoundary` divides by it), `notify` a real boolean, and each of
  `cueWork`/`cueBreak`/`cueLongBreak` a name in the live cue set (`src/cues.mjs`) or `"None"`. A
  patch that fails is a **400** naming the offending field (`{ error }`) and writes nothing;
  unknown keys are dropped rather than stored or rejected. Changing a duration does not retarget
  a running interval — the new value applies at the next boundary crossing.
- `preview` takes `{ cue }` against that same closed set, with `"None"` a legal choice that
  previews as silence rather than a 400. It plays the file directly with `afplay`, so auditioning
  never raises a banner, and a newly selected cue kills whatever preview is still playing.
  `notifyTest` is the Notify checkbox's equivalent audition, and ignores the stored `notify`
  setting because the tick that triggered it has not been saved yet.

### Marking an already-open tab

Three marks, and no others (ADR 30): the unbadged board mark every page emits in its `<head>`
(`faviconLink`, `src/styles.mjs`); a **counted** mark drawn over it on a `round` push; and
`restFaviconHref`, on the index tab only, while the pomodoro is in an unpaused break. A pending
count outranks the rest mark outright. `document.title` is left alone.

The favicon mark is the only notice the page itself raises; a round nobody is watching for is the
daemon's own native banner instead ("The stranded banner", below), which is what a closed or
buried tab now relies on. Every part of the mark degrades silently: a failure anywhere leaves the
round pushed and the page working, just unmarked, and all of it is inert in readonly mode. Shim
side: printing the board URL in chat as the fallback that cannot fail.

## SSE events

`GET /api/board/:id/events`: a `text/event-stream` subscription, one per connected client, for
round pushes and submits on `:id`. 404s up front if the board doesn't exist; otherwise the response
never ends on its own. Heartbeat comment lines (`: heartbeat\n\n`) keep it alive through idle
timers and proxies — invisible to `EventSource`'s message events, so they never surface as a stray
event. `CLAUDE_BOARD_SSE_HEARTBEAT_MS` overrides the cadence (default 15000), for checks only.

Four named events. The middle two carry the full board JSON (the same shape a served page inlines)
so a client can diff against its own last-known copy, plus enough to apply the push without a
reload:

```js
event: watcher        data: { id }
event: round          data: { round, mode: 'new-round' | 'amend', blockIds, html, board }
event: submitted      data: { round, board, html }
event: awaitExpired   data: { round }
```

`watcher` is the first thing the stream sends, ahead of any of the other three, on every open and
every reconnect alike: a server-minted id naming this one connection (CONTEXT.md "Watcher"), which
the same tab then carries on every `POST /api/board/:id/attended` it sends (see below) so the
daemon knows which live connection an attended report is updating. It is not a credential — it
authorizes nothing on its own, the cookie still does that — only an identifier scoped to one open
stream and worthless once that stream closes.

`html` is a pre-rendered fragment covering exactly `blockIds` — never the whole page — so the
client only ever inserts or replaces that much DOM: `renderRoundSection`'s output (a full
`<section class="round">` wrapper) for `mode: 'new-round'`, or one `renderBlock` call per touched
id (no wrapper) for `mode: 'amend'`, since the round section already exists client-side.

`submitted` fires on every submit, to every connected client including the one that just
submitted, so a second tab sees the round go sent — and read-only, if that page is the one it is
showing — without reloading. Its `html` is the re-rendered `<section class="round">` in sent/history
form; without it a client that did not
submit would show its own unsent, in-progress state as if it were what was sent. A client that
receives no `html` must fall back to disabling the round in place.

`awaitExpired` is the one event that carries no board: it fires from `GET /api/board/:id/wait`'s
own timeout branch, at the moment that wall clock gives up, and is a wake-up nudge rather than a
second copy of anything. Everything a tab needs to decide "read-only now" is already in
`board.rounds` and its own clock (`roundIsCurrentlyAwaited`, `src/badge.mjs`), and the daemon has
by then cleared the round's `awaited` flag and persisted it, so a client that refetches instead of
recomputing sees the same answer. A client that misses it is not stranded — the page re-checks its
own deadline on a ~20s tick regardless, which is what an archive and a sleeping laptop rely on.

The client subscribes only when NOT running read-only from `file:` — the standalone archive stays
network-free.

**Resync on every open.** The stream carries no replay and the daemon emits no `id:` lines, so a
broadcast that lands while a client is disconnected (a sleeping laptop, a tab restored while the
agent is mid-amend) is lost permanently. So on **every** `open` of the subscription — the first
connection included — the client re-reads the board and diffs it against its local copy with the
same `computeBoardPatch` (`src/patch.mjs`) every push uses, replaying the difference through the
same apply path as a live push. A first connection with nothing missed diffs to nothing and
touches no DOM. The re-read is a plain `GET /b/:boardId`, which already inlines both the payload
(`#board-data`, `resolveComment` already run over it) and the server-rendered markup for every
round; a dedicated JSON route would be leaner and can be added later without changing this rule.

## Stage postMessage channel

The page's second wire contract, between the board page and an `html` block's sandboxed stage.
`src/render.mjs`'s `stageAgentScript` is the stage half; `src/ui.mjs`'s message listener is the
parent half. Rationale for the isolation model lives in `SECURITY.md`; this section owns the
message tables and the two validation rules.

The frame carries `sandbox="allow-scripts"` and no `allow-same-origin`, so its browsing context
has an **opaque origin**: `frame.contentDocument` throws or returns null from the parent's side,
and a script inside the mock cannot reach the parent's window or document at all. The parent
therefore cannot read an element's text, build a step path, or draw a pin from the stage's live
layout. Everything it used to do by reaching in now happens over this channel, and nothing else.

Every message is a plain object carrying `cb: 'cb-stage'` — a marker namespacing this channel
from anything else that might postMessage this window (an extension, devtools, a future feature)
— and a `type`.

### Stage → parent

| type | payload | meaning |
| --- | --- | --- |
| `ready` | — | listeners attached. Sent once, unconditionally, at the end of the agent script |
| `hover` | `{ ref, tag, text }` | innermost element under the cursor, or `ref: null` on mouseout. The stage also applies its own outline locally |
| `click` | `{ ref, tag, text }` | step path plus **raw** tag/text, never a composed hint |
| `positions` | `{ requestId, positions }` | response to `locate`: per requested ref, `{left, top}` relative to this document's `<body>`, or `null` if the ref no longer resolves. Numbers and null only |
| `height` | `{ height }` | `document.body.scrollHeight` |
| `scroll` | `{ top }` | "I am at this offset". Deduplicated on the last reported value |

`ref` is a `buildSteps`/`stepsToPath` index chain from `document.body`.

`click` carries raw tag/text rather than a hint because composing *identity in context*
(`composeHint`, `src/anchor.mjs`) needs the outer document's knowledge of whether this stage sits
inside a compare side, which the stage cannot see. The parent calls `buildHint` on what it
receives, through the same function every other content kind's click already uses. This is also
why `composeHint` needs no third copy embedded here: only
`buildSteps`/`stepsToPath`/`pathToSteps`/`resolveSteps` do, bound via `.toString()` from
`src/anchor.mjs`, never hand-copied.

`positions` only ever positions a pin the parent already decided to draw from its own
server-verdict-derived comment list (`commentsWithPending`), never to decide *whether* a pin
exists.

`height` is stage-authored like every other field, so the parent clamps it between
`STAGE_HEIGHT_FLOOR` and `STAGE_HEIGHT_CAP` (320 / 600) before it touches a frame's inline
style. The cap stops a hostile or viewport-sized report growing a card without limit; the floor
stops a report that measured a collapsed sliver of chrome from locking the card there forever,
since a taller report never arrives from content that is not reflowing. Applied only to a stage
inside a `.choice-variant` card.

`scroll` exists because ADR 40's page-board header condenses on the reader's scroll, but on a page
board the document itself never scrolls — the artifact scrolls inside the opaque-origin frame — so
the parent cannot observe it short of being told.

### Parent → stage

| type | payload | meaning |
| --- | --- | --- |
| `mode` | `{ commentMode }` | comment mode on/off. The stage keeps its own flag, read by the same `if (!commentMode) return;` guards the old in-parent listeners used |
| `locate` | `{ requestId, refs }` | asks for the current `{left, top}` of every ref |
| `band` | `{ top, bottom }` | the board's own chrome band, right now (ADR 59) |
| `scroll` | `{ top }` | "put yourself at this offset" |

`scroll` is the one bidirectional type on this channel. Inbound it is sent only as a reset,
`top: 0`, by the board's back-to-top control, since the parent cannot scroll a cross-origin
document itself. Both directions aim at whichever element most recently identified itself as the
scroller, never at the document by assumption.

The hover stylesheet is injected lazily, the first time `commentMode` turns true. A read-only
archive never sends `mode` at all (`setCommentMode` refuses to enable comment mode when
`readonly`), so an archived stage's document never gains one.

`band` exists because the parent's header, dock and comment rail float **over** the frame rather
than pushing it down, so an artifact that pads nothing loses its own opening under them. No fixed
number is baked in on either side — the header's real height moves with the title's wrap and the
viewport width — so the parent measures its live chrome (`reportStageBand`) and the stage tops its
own `body` padding up to at least that much, rather than overwriting padding the artifact already
had. Parent to stage only: reserving space for the board's chrome is the board's decision, never a
negotiation.

`locate` and `band` are both sent once a stage announces `ready`, and again whenever the parent's
own refresh runs (resize, a comment queued, a submit landing, a round flip).

### There is no `select` message, deliberately

An earlier version had the stage post a content-free `select` on every click, so clicking the
visible mock content of an `html`-kind option could pick that option. Reverted before that work
merged.

Every message on this channel is stage-authored input, no different in kind from the mock's own
HTML. Unlike `click`/`hover`, which only *propose* an anchor a human still has to submit, or
`positions`, which is pure geometry, a message that picks an option is the agent handing itself
the answer to its own question. Two paths made that concrete: the stage's own script could
dispatch a click on itself with no human involved, and — since `cb: 'cb-stage'` is a fixed public
string, and the validation below proves only that a message came from *some* live stage, never
that a human acted — any stage's script could call `postMessage({cb:'cb-stage', type:'select'})`
directly. An `ev.isTrusted` guard would have closed the first path only; the second forges the
message upstream of any such guard.

Deleted rather than guarded. An option's stage is a thumbnail to choose between, not a surface to
operate, so it renders `pointer-events: none` inside a `.choice-variant` card: a real click over
the visible mock never reaches the iframe and lands on the card in the parent document, which
already handles it. A forged `select`-shaped message from a live, correctly-addressed stage is
inert because no handler is left to act on it.

### Origin validation

An opaque-origin `srcdoc` frame has no real origin, so the usual same-origin comparison is
meaningless here. Each side validates something else.

**Parent reading a stage message** checks `event.origin === 'null'`. The HTML standard serializes
an opaque origin in a `postMessage` event as the literal four-character string `"null"`, always,
regardless of what URL or port the parent page is served from. That is not an origin we happen to
trust, it is the *absence* of one: any message carrying a real origin — an extension, devtools, a
same-origin script the reviewer runs in the same tab — is rejected before any shape check runs.
Necessary but not sufficient, since it does not say *which* stage.

**Parent identity check**: `event.source` must equal the `contentWindow` of a currently-mounted
`.html-stage` frame. The browser stamps `event.source` from the calling script's actual global
object, so no page script can forge it — it is not read off `event.data`, which is
attacker-controlled. Re-deriving which stage by walking the live DOM at receive time, rather than
trusting an id the message claims, is what makes it the frame the parent thinks it is.

**Stage reading a parent message** checks `event.source === window.parent`. The stage cannot know
the parent's real origin in advance (any port, or `file://`), so an origin string check is not
available to it — and is not needed. `window.parent` is a reference the browser hands the script
at frame-creation time, and no script in any window can make `event.source` equal a different
window's `window.parent`. Identity alone is sufficient here.

### Shape validation

Neither side trusts a message's shape beyond what it explicitly checks. The stage document is
attacker-controlled, so the parent assumes the mock's own script sends it hostile messages on the
same channel the agent uses.

Every handler on both sides checks every field's type before using it — `typeof x === 'string'`,
`Array.isArray`, `Number.isFinite` — and drops what does not match rather than throwing or
coercing. The parent never evaluates, renders as HTML, or otherwise trusts a string from the
stage: a hint is composed via the same `buildHint`/`composeHint` every other click uses (never
`innerHTML`), and every anchor field reaches the comment form through
`setAttribute`/`textContent`, never string-concatenated into markup.

Checked by `test/check-stage-isolation.mjs` and `test/check-click.mjs`'s malformed and
hostile-message cases. `test/dom-stand-in.mjs`'s `StandInWindow` models a stage's `window.parent`
as an object exposing only `postMessage`, never `.document`, for the same reason.

## MCP surface

One tool, `ask`, on the stdio shim. Arguments mirror the board document: `{ title, blocks, wait? }`,
where question blocks carry their questions by value and content blocks carry a `source` ref. It
posts a board and opens the tab on the thread's first board.

Whether it then waits is derived from the round just posted, not purely from `wait`: a round
carrying a question block anywhere in it (top-level, or nested in a question's `context` or a
`compare` side) always blocks on `/api/board/:id/wait`, emitting `notifications/progress`
throughout so the idle timer never fires. A round with no question blocks on `/api/board/:id/wait`
too, but only when it is a page board — one `html` block and nothing else — AND the call carried
`wait: true` (ADR.md entry 45, CONTEXT.md "Awaited"); every other content-only shape returns the
instant the post succeeds regardless of `wait`, packet `status: 'posted'`. `wait` defaults to
`false`, and the wall-clock cap either route blocks on is the same 40 minutes (ADR.md entry 47).
The return condition is the post succeeding, never the tab opening: `open` is spawned detached and
this process never learns whether a tab appeared. Opening stays best-effort and its failure stays
non-fatal.

Failure is loud and writes nothing, on three triggers: an unreachable daemon (returns the revive
command), a non-interactive session, or a session on which nothing can open a tab at all — an SSH
session on a machine with no display passes the first two checks and would otherwise post a board
nobody can see and block for the full wall-clock cap. Both session checks are below.

The shim tracks one thread per process (one shim per Claude session): the first `ask` call starts
a new thread and opens its tab; every later `ask` call in the same process pushes a round into the
same live board (`POST /api/board` with `boardId` set) and opens no tab of its own. A round
landing with nobody watching is the daemon's stranded banner to raise, not the shim's tab to force
open. `bin/authorize.mjs` still opens a tab, being the standalone recovery command a reviewer runs
deliberately.

### MCP shim environment

Additive to `CLAUDE_BOARD_HOME` / `CLAUDE_BOARD_PORT` above.

```
CLAUDE_BOARD_TIMEOUT_MS       wall-clock cap on the blocking wait, default 40m (2_400_000,
                               ADR.md entry 47) -- shared by the daemon's own /wait cap
CLAUDE_BOARD_PROGRESS_MS      notifications/progress cadence, default 20_000 (20s)
CLAUDE_BOARD_POST_TIMEOUT_MS  timeout on POST /api/board only, default 10_000; never applied
                               to the /wait call, which must survive the full wall-clock cap
CLAUDE_BOARD_RETRY_MS         reattach backoff after the daemon drops a held-open wait,
CLAUDE_BOARD_RETRY_MAX_MS      default 250ms doubling to 2_000ms: short enough that a launchd
                               restart reattaches at once, capped so a longer outage is not a
                               hot loop
CLAUDE_BOARD_HEADLESS=1       forces the non-interactive refusal regardless of entrypoint --
                               also the documented manual opt-out: set it deliberately on a
                               machine that COULD open a tab, to use the terminal this session
CLAUDE_BOARD_NO_OPEN=1        skip opening a tab at all (checks only; never set by a user) --
                               opening deliberately SUPPRESSED, which is why this does not
                               also trip the "cannot open a tab" refusal: a real caller never
                               sets it, so that refusal only fires where it is unset
CLAUDE_BOARD_OPEN_CMD         command used to open the board URL, default `open`. Setting this
                               on a non-darwin machine is what satisfies the "cannot open a
                               tab" refusal for real: it is the one way a caller states that
                               something CAN show a human the board
CLAUDE_BOARD_ASSUME_PLATFORM  overrides process.platform for the "cannot open a tab" decision
                               only (checks only) -- there is no second OS on the machine that
                               runs this suite to exercise the non-darwin branch on for real
CLAUDE_BOARD_SECRET_FILE      where the local secret lives, default
                               ~/.config/claude-board/secret. Read by install.sh, the daemon
                               and the shim alike; a testing seam, not configuration
```

## Detecting a session with no human in it

Measured on Claude Code 2.1.220, not extrapolated: an interactive terminal session exports
`CLAUDE_CODE_ENTRYPOINT=cli`, while `claude -p` exports `CLAUDE_CODE_ENTRYPOINT=sdk-cli`. Both
export `CLAUDECODE=1`, so that variable discriminates nothing.

The shim therefore treats interactivity as an **allowlist and fails closed**: post only when
`CLAUDE_CODE_ENTRYPOINT` is one of `cli`, `vscode`, `jetbrains`, `ide`, `claude-desktop`,
`claude-desktop-3p`. Any other value — and an absent value — is a session with nobody watching,
and `ask` refuses before anything is posted or written. `CLAUDE_BOARD_HEADLESS=1` forces the
refusal regardless, which is the hook an unattended runner sets.

Known residual gap, deliberately not papered over: `/nightly` and `/loop` run *inside* an
interactive session, so the entrypoint still reads `cli` and no env check can see them. That is a
rule those commands must carry, not a mechanism the shim can enforce.

**A third, distinct refusal: the daemon cannot open a tab.** SSH onto a machine with no display
exports `CLAUDE_CODE_ENTRYPOINT=cli` and reaches the daemon fine, but `openBoardTab`
(`bin/mcp.mjs`) silently no-ops on a non-darwin platform with no `CLAUDE_BOARD_OPEN_CMD`
configured — there is no mechanism at all on that machine to put a tab in front of a human. So
`ask` refuses up front, before anything is posted: platform is `darwin`, or `CLAUDE_BOARD_OPEN_CMD`
names an explicit opener, or refuse. This is checked independently of the interactivity allowlist
— a session can be interactive and still have nowhere to show the board — and, symmetrically with
`CLAUDE_BOARD_HEADLESS=1`, is not tripped by `CLAUDE_BOARD_NO_OPEN=1`.

## The prose-vs-shim checker

`src/prose-check.mjs` parses a prose file and asserts it against the shim's live `tools/list` and
this document: the file is substantial prose, it names the tool (default `ask`) literally, that
tool exists, every argument its live schema declares is named in the prose, no argument it claims
is missing from the schema, and every `kind:`/`widget:` in a worked example is one the `### Blocks`
section above defines. An argument counts as named either backticked or as an object key inside a
fenced code block (`title: '…'` or the ES6 shorthand `title,`) — never a bare substring match,
since `title` and `blocks` are ordinary English words. `delegatesTo` swaps the two "documents the
call" assertions for "names the skill that owns the call", for a caller that points at the manual
instead of restating it.

`test/check-skill-prose.mjs` runs it against `skills/claude-board/SKILL.md` on every
`node test/run.mjs`, and adds the opposite duty: every block kind, widget and packet status this
document defines must **appear** in the manual, since one it omits is one no caller will reach
for. `test/check-prose-check.mjs` proves the checker itself against fixtures
(`test/fixtures/prose-check-*.md`), in both directions.

Named exports: `checkProseFile` (the one-call entry point — spins up a throwaway daemon and shim,
never a real install), `assertProseMatchesShim` (same, printing each assertion and throwing one
readable summary Error), `formatFailures`, `checkProse` (the pure battery), `getLiveTools`,
`parseBlockShapes`, `parsePacketStatuses`, `extractClaims`, `extractFencedCode`,
`argumentNamedInProse`, `resolveInstalledRoot` and `loadInstalledChecker`. The module's own header
is the reference for how a caller outside this repo finds the file (the `WorkingDirectory` key in
the installed LaunchAgent plist) and for the small bootstrap that inlines it.

Reach for that bootstrap last. In order of cost: a caller that restates no protocol needs no check
at all, which is now every caller but one; a caller making a single vocabulary claim asserts it
against the installed manual at `~/.claude/skills/claude-board/SKILL.md`, a plain file read; only
a caller needing the full battery against a live shim pays for the bootstrap.

## Checks

`node test/run.mjs` runs the checks named in its own list — among them `check-pure`, `check-http`,
`check-mcp`, `check-install`, `check-prose-check` and `check-skill-prose` — and each is also
runnable alone. The list is a literal in `test/run.mjs`, not a glob, so a new `test/check-*.mjs`
file is invisible to the suite until it is added there. The count is deliberately not written down
here; it was "five" for long enough to go stale twice. No browser, no network, no writes outside a
temp `CLAUDE_BOARD_HOME`. Every check that touches the local secret points
`CLAUDE_BOARD_SECRET_FILE` at its own temp dir first: the real `~/.config/claude-board/secret` is
never read, written, or rotated by a check run.
