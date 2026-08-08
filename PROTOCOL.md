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
| `src/badge.mjs` | the round badge's label, pure |
| `src/lens.mjs` | the diagram lens's view math, pure |
| `src/prose-check.mjs` | the prose-vs-shim checker (below). Ships from `src/` so a caller outside this repo can import it |
| `src/cues.mjs` | the cue vocabulary: the closed set of legal cue values, enumerated live from BOTH sound directories (`/System/Library/Sounds` and `~/Library/Sounds`, ADR 23) plus `"None"`, memoised on a 5-second TTL |
| `src/pomodoro.mjs` | the global pomodoro clock: the pure boundary rule, the document's shape on disk, the impure shell the daemon boots. Absolute deadlines, so a restart is invisible and a deadline slept through expires silently |
| `src/pomodoro-widget.mjs` | the timer's server-rendered markup for the index page; its client half extends `src/indexpage.mjs`'s script by concatenation |
| `src/notify.mjs` | one native notification per interval boundary, carrying that phase's cue. The bundle's own executable in `--notify` mode inside `claude-board.app` (ADR 19), `osascript` only on the no-launcher clone install; message text and cue both come from closed-set lookups |
| `skills/claude-board/SKILL.md` | the manual for the `ask` tool, and the only prose statement of this protocol a caller reads. `install.sh` copies it to `~/.claude/skills/claude-board/` (ADR 11); `test/check-skill-prose.mjs` binds it to the live shim |
| `test/check-*.mjs` | the suite; `test/run.mjs` carries an explicit list of them rather than globbing, so a new check runs only once its filename is added there |

Zero dependencies: `node:*` built-ins only, ESM (`.mjs`) throughout, no bundler, no build step.
Mermaid is the sole exception and stays client-side from its CDN.

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
  rounds: [ { n, postedAt, status, sentAt, title, action? } ],  // status: 'open' | 'sent'
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
comment half of entry 26 and narrows entry 6).

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
      "action": "submitted" },
    { "n": 2, "postedAt": "2026-08-06T20:16:35.034Z", "status": "open",
      "sentAt": null, "title": "fix/session-timeout" }
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

`posted` means the round carried no question block anywhere in it — top-level, or nested in a
question's `context` or a `compare` side — so there was nothing to submit and the shim returned
the instant the post succeeded rather than waiting at all. `answers` and `comments` are always
empty on a `posted` packet. `discuss` means the reviewer chose Discuss in chat: partial answers
are included and the agent must stop posting boards for the rest of the session. `timeout` is the
wall-clock cap (default 2h) and carries an explicit no-response — an empty `answers`, and no
comments beyond the undelivered ones described next, which are owed to a timed-out round exactly
as they are to any other.

**Scope: one packet is one round, with one exception.** `answers` holds exactly the question
blocks whose `round` is the packet's `round`, and `comments` exactly the comments left in it.
Round 6 does not redeliver rounds 1-5: the agent would re-address settled feedback and re-report
an old `unanswered`/`deferred` as a fresh signal, louder each round. Every entry carries its own
`round` (and each comment its `createdAt`), so a caller that wants the thread's history reads
`board.answers` / `board.comments`. The stored board keeps everything; the packet is the round.

**The exception: a comment left on a round that asked nothing** (ADR.md entry 35). A page board
is a round with no question block, so nothing ever waits on it and nothing would otherwise carry
its comments back — the reviewer's feedback on the artifact would sit in the store unread. Such
a comment rides the next packet the same thread returns, once, appended to that packet's own
`comments`; it carries its own `round`, which is how a caller tells it from the round in hand.
Once, not once per round: the packet is committed as delivered only after the response has
actually left, so a dropped connection re-delivers rather than loses, and a delivered comment is
never sent again. Collecting comments from a page board therefore costs a later round that asks
something — an agent that wants them posts one rather than polling for it.

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
                                    -> { boardId, thread, round, url }
GET  /api/board/:id/wait?round=N    blocks until the round is sent -> Packet
GET  /api/board/:id/events          SSE: round pushes, state changes
POST /api/board/:id/submit          { round, action: 'send'|'discuss', answers, comments }
GET  /api/search?q=                 archive search
GET  /api/pomodoro                  the whole document -> { settings, cycle, cycleDate, timer, now }
POST /api/pomodoro/ensure           ensure a timer exists; no-op if one already does (any phase)
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
                                    cueWork?, cueBreak?, cueLongBreak? }
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

**Every non-GET request** must carry it — except `POST /api/board/:id/submit`, which also takes
the session cookie below. A missing or wrong credential is **401 with no body**: nothing about
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

It is additionally accepted on nine pomodoro writes — `ensure`, `pause`, `resume`, `reset`,
`settings`, `preview`, `notifyTest`, `forward`, `restart` — so the index page's switch and its
settings popover can drive the clock. That clock never touches a board, never gates an `ask` and
never reaches a tool, so it costs the cookie nothing it did not already carry (ADR 17, 24). The
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

`{ title, blocks, cwd?, thread? }` starts a new thread; `{ boardId, blocks, title? }` pushes into
a live one. `cwd` is only meaningful on the thread-creating form. `title` is meaningful on
**both**: on the `boardId` form it labels the round being minted or amended.

Pushing into a live board **amends** the latest round in place — a block whose incoming id
already exists on the board replaces it, everything else is appended to that same round — while
that round is still `open` **and carries a question block somewhere in it**. Otherwise it mints a
new round. Either way the response is `{ boardId, thread, round, url }`, `round` naming whichever
round was amended or minted.

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

### `GET /api/board/:id/wait?round=N`

A server-side wall-clock ceiling matching `CLAUDE_BOARD_TIMEOUT_MS` (default 2h): when it fires
the call returns 200 with a packet whose `status` is `timeout`, carrying whatever partial answers
the store holds. A client that disconnects ends the wait outright — nothing is written and the
poll stops.

### The pomodoro routes (ADR 8, 17, 20, 24)

Everything the table above does not say:

- `GET /api/pomodoro` returns the whole document (`src/pomodoro.mjs` `defaultDoc`) plus `now`, the
  daemon's own `Date.now()` at response time, so the page computes `serverNow - Date.now()` once
  and keeps subtracting that offset rather than trusting the browser's clock against a
  server-minted deadline. Every write route returns the same `{ ...document, now }`, reflecting
  the state immediately after that write — except `preview` and `notifyTest`, which return
  `{ ok: true }`.
- `ensure` is *ensure*, never *start*: a running, paused or mid-break timer is left untouched, so a
  second session, a `/clear`, a resume or a session in another project is a no-op and starting
  mid-break does not cut the break short. It is deliberately callable with **no body at all** —
  `readJsonBody` is never invoked on it — so a one-line `curl -X POST` from a shell hook works.
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

Three marks, and no others (ADR 30, 31): the unbadged board mark every page emits in its `<head>`
(`faviconLink`, `src/styles.mjs`); a **counted** mark drawn over it on a `round` push; and
`restFaviconHref`, on the index tab only, while the pomodoro is in an unpaused break. A pending
count outranks the rest mark outright. `document.title` is left alone.

A `round` push also raises a `Notification`, but only while the document is hidden or unfocused.
Its `tag` is `claude-board-<boardId>-<n>`, so two unread rounds are two entries and only a genuine
re-delivery collapses; its click calls `window.focus()` and flips to the open round's page through
the same `jumpToOpenRound` the round badge uses. Permission is requested lazily on the first round
that would notify and on a Send click, and a denial is never re-prompted. Every part degrades
silently: a failure anywhere leaves the round pushed and the page working, just unmarked, and all
of it is inert in readonly mode. Shim/daemon side: reopening the tab when no client is connected
at all, and printing the board URL in chat as the fallback that cannot fail.

## SSE events

`GET /api/board/:id/events`: a `text/event-stream` subscription, one per connected client, for
round pushes and submits on `:id`. 404s up front if the board doesn't exist; otherwise the response
never ends on its own. Heartbeat comment lines (`: heartbeat\n\n`) keep it alive through idle
timers and proxies — invisible to `EventSource`'s message events, so they never surface as a stray
event. `CLAUDE_BOARD_SSE_HEARTBEAT_MS` overrides the cadence (default 15000), for checks only.

Two named events, both carrying the full board JSON (the same shape a served page inlines) so a
client can diff against its own last-known copy, plus enough to apply the push without a reload:

```js
event: round      data: { round, mode: 'new-round' | 'amend', blockIds, html, board }
event: submitted  data: { round, board, html }
```

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

## MCP surface

One tool, `ask`, on the stdio shim. Arguments mirror the board document: `{ title, blocks }`,
where question blocks carry their questions by value and content blocks carry a `source` ref. It
posts a board and opens the tab on the thread's first board.

Whether it then waits is derived from the round just posted, not from a mode flag: a round
carrying a question block anywhere in it (top-level, or nested in a question's `context` or a
`compare` side) blocks on `/api/board/:id/wait`, emitting `notifications/progress` throughout so
the idle timer never fires; a round of content blocks only returns the instant the post succeeds,
packet `status: 'posted'`. The return condition is the post succeeding, never the tab opening:
`open` is spawned detached and this process never learns whether a tab appeared. Opening stays
best-effort and its failure stays non-fatal.

Failure is loud and writes nothing, on three triggers: an unreachable daemon (returns the revive
command), a non-interactive session, or a session on which nothing can open a tab at all — an SSH
session on a machine with no display passes the first two checks and would otherwise post a board
nobody can see and block for the full wall-clock cap. Both session checks are below.

The shim tracks one thread per process (one shim per Claude session): the first `ask` call starts
a new thread and opens its tab; every later `ask` call in the same process pushes a round into the
same live board (`POST /api/board` with `boardId` set) and reopens the tab only when no client is
connected to that board at all. It never reopens a tab the reviewer already has open.

### MCP shim environment

Additive to `CLAUDE_BOARD_HOME` / `CLAUDE_BOARD_PORT` above.

```
CLAUDE_BOARD_TIMEOUT_MS       wall-clock cap on the blocking wait, default 2h (7_200_000)
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
