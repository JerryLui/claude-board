# PROTOCOL — shared contract for `claude-board`

The wire contract: the shapes on disk, the routes that move them, and what each side refuses.
`SECURITY.md` owns the rationale behind the gates; this file owns the enumerated rules and the
tables. `skills/claude-board/SKILL.md` is the prose manual a caller reads.

**Changing this file:** changes are additive. A shape that is not here gets a new field, added
here in the same commit that uses it. Do not repurpose or rename an existing field. Removing
one takes an ADR that names the field and every consumer moved off of it — ADR 99 (the
packet's `resolved`, redundant beside `lost`) is the shape of that exception.

## Layout

| module | what it owns |
| --- | --- |
| `bin/daemon.mjs` | the HTTP server's entry point |
| `bin/mcp.mjs` | stdio MCP shim, one per Claude session |
| `bin/authorize.mjs` | the recovery command: mint a handoff and open the browser |
| `bin/launcher.c` | launchd entry point, compiled by `install.sh` into a signed app bundle that forks the daemon, so macOS TCC has an application of ours to attribute its file reads to. Also the two C functions both native click surfaces share: the board-URL scanner (`cb_is_board_url`) and the tab surfacer (`cb_surface_tab`) |
| `bin/notify.m` | the bundle's `--notify` mode: one native notification, posted natively rather than through `osascript`. Its click serves the board through `cb_surface_tab` (`bin/launcher.c`), which does spawn `osascript` — to raise the tab the board is already open in rather than open a second one (ADR 93) |
| `bin/menubar.m` | the bundle's `--menubar` mode: the macOS status item, forked beside the daemon as a second child of the launcher (ADR 72) |
| `src/store.mjs` | board and mission JSON persistence: read, write, list, search, prune |
| `src/board.mjs` | the model: id minting, block normalisation, rounds, packet assembly |
| `src/markdown.mjs` | markdown -> HTML + anchor extraction; runs in node and in the browser |
| `src/anchor.mjs` | element-level (`dom`/`mermaid`) anchor path and hint logic, pure. `src/ui.mjs` carries a duplicate as plain functions, since the served page has no import graph at runtime |
| `src/resolve.mjs` | content-by-reference resolution and sha snapshotting |
| `src/render.mjs` | board JSON -> complete HTML page (pure function) |
| `src/indexpage.mjs` | the two home views under one top bar: Missions at `/`, its columns and card buttons, and the Boards view at `/boards`, the list of Threads and its session filter |
| `src/missions.mjs` | the missions ledger: the writable fields and their caps, the derived view (`view`, `live`, `actions`), the launch check and its caps, sessions, orders, board links |
| `src/mission-watch.mjs` | the daemon's 30-second read of every mission: publishes the derived changes no write made, and speaks one batched notification a minute (ADR 128) |
| `src/server.mjs` | the `node:http` daemon: routes, SSE, the four gates below |
| `src/stranded.mjs` | the stranded rule: a board no Watcher is looking at, carrying an awaited round or a Suppressed board's own first round, gets one banner per absence, after a grace. Persistence, grace timers and the click-serving child's lifecycle, all behind `createStrandedWatch` |
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
| `src/notify.mjs` | one native notification per interval boundary, carrying that phase's cue. The bundle's own executable in `--notify` mode inside `claude-board.app` (ADR 19), `osascript` only on the no-launcher clone install; message text and cue both come from closed-set lookups, a round's folder name and a missions batch's line each passing a filter first (ADR 56, 128) |
| `skills/claude-board/SKILL.md` | the manual for the `ask`, `read` and `mission` tools, and the only prose statement of this protocol a caller reads. `install.sh` copies it to `~/.claude/skills/claude-board/` (ADR 11); `test/check-skill-prose.mjs` binds it to the live shim |
| `test/check-*.mjs` | the suite; `test/run.mjs` carries an explicit list of them rather than globbing, so a new check runs only once its filename is added there |

Zero *installed* dependencies: no `npm install`, no `node_modules`, no bundler, no build step;
ESM (`.mjs`) throughout. `marked`, `prismjs` and mermaid are vendored as pinned, digest-guarded
source under `src/vendor/` (ADR 62); `marked`/`prismjs` run server-side at post time, mermaid
client-side at view time, from the daemon's own origin rather than a CDN.

## Paths

The store root is `CLAUDE_BOARD_HOME`, defaulting to
`~/Library/Application Support/claude-board`. Unlike the other env vars here, this one is
user-facing configuration as well as the seam the checks run against.

```
$CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
$CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, openable with its folder
$CLAUDE_BOARD_HOME/pages/ui-<hash>.js       the shared client script a page names
$CLAUDE_BOARD_HOME/pages/styles-<hash>.css  the shared stylesheet a page names
$CLAUDE_BOARD_HOME/pages/mermaid-<hash>.js  the shared diagram engine, named by ui.js
                                             rather than by any page (vendored, ADR 62)
$CLAUDE_BOARD_HOME/pomodoro.json            the pomodoro clock and its settings (ADR 8)
$CLAUDE_BOARD_HOME/missions/<key>.json      one mission record (ADR 123), see "The missions
                                             routes" below
```

A page does not carry the client script or the stylesheet; it *names* them, as a bare
sibling filename hashed from their contents (ADR 70). The diagram engine is a third such
sibling, loaded the same content-addressed way, but named only by `ui.js` rather than by
any page's own markup — a board loads it on demand, when it actually has a diagram. A bare
name is the one reference that resolves the same served (`GET /b/<name>`, the daemon's only
static route) and opened from Finder (the file next to the page), so an archive still opens
with the daemon stopped — as long as its folder travels with it. The assets are append-only:
changing any payload mints a new name and leaves the old file untouched, so a page written a
year ago keeps loading the exact bytes it was rendered against. Pages already on disk before
this split keep their inlined copies forever; nothing rewrites a written archive.

`pomodoro.json` is the one thing here that is not a board, and the one thing `uninstall.sh`
removes from this directory — by exact name, never a glob. It is configuration this repo
authored (a deadline, a break length), not review history the user accumulated. See
`src/pomodoro.mjs` for the document shape. Uninstalling therefore still leaves the whole
store in place; that has not changed.

Nothing in this directory expires. No read, no daemon start and no timer has ever removed
a board, and none does now. What does exist is a **prune**, fired by hand from the
settings panel on the index (`POST /api/store/prune`, ADR 71): it deletes every board
older than a window the caller names — document and emitted page together — and then any
shared asset no surviving page or asset still names, and every mission record whose `retiredAt`
is at least 30 days old (ADR 123). The window has no default; a prune that does
not name one is refused. This is the only thing in the system that ever deletes a board,
so how long a board survives is the reader's decision and nothing else's.

Daemon listens on `127.0.0.1:7391` (`CLAUDE_BOARD_PORT` overrides, for the checks).
Non-daemon callers (shim, demo, authorize) resolve the port as `CLAUDE_BOARD_PORT`,
else the port record install.sh writes beside the secret, else 7391 —
`daemonPort()` in `src/secret.mjs`. The daemon itself never reads the record:
launchd's plist environment is the one authority for what it binds.

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
  rounds: [ { n, postedAt, status, sentAt, title, action?, awaited, awaitDeadline, abandonedAt? } ],
                                     // status: 'open' | 'sent' | 'abandoned'
  blocks: [ Block ],                // every block of every round, in display order
  answers: { [questionBlockId]: Answer },
  comments: [ Comment ],
  mission?,                         // the mission key a post named (ADR 123)
  session?: { pid, procStart, id }, // the agent session that first posted (ADR 131); id null
                                     // until the session watcher lists that process
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

**`status: 'abandoned'`** (ADR 69) is the third and last way a round closes: the conversation
that owned the board declared a boundary (`fresh` on `ask`, "MCP surface" below) and walked away,
so `POST /api/board/:id/abandon` closed every round still open on it. It is deliberately neither
of the other two outcomes. A submit would record that a human answered, and nobody did; a lapse
(`awaited: false`, `status: 'open'` — see below) would leave the round advertising itself as open
on a board nothing will ever post to again. `awaited` goes `false` with it, `sentAt` stays `null`,
no `action` is recorded (so nothing reads it back as an answer), `awaitDeadline` is left exactly
as minted, and `abandonedAt` is the ISO stamp of when it happened. Every reader that asks whether
a round is open asks `status === 'open'`, so an abandoned round drops out of the send bar, the
index badge, the "rounds left" count and the stranded rule with no rule of its own. **A round
written before this state existed carries only `open` or `sent`,** and reads identically.

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

**`answersDelivered`** (ADR 107) is a daemon-only ledger beside the rounds: the round numbers of
this board whose answers a packet has actually carried out, ascending. It is what makes the
packet's second exception decidable — a `sent` round missing from it is owed to the next packet
the thread returns — and it is written only when a packet naming that round has genuinely left,
never at submit time and never at mint time. Like `strandedBanner` and `suppressed` it is stripped
from everything a client sees, and for a sharper reason than either: it is written on a wait's own
`finish` with no re-render beside it, so a per-round flag would make the served page disagree with
`pages/<id>.html` on every wait that resolves. **A board written before this field existed carries
no key at all**, which is not the same as an empty one: the first packet that touches such a board
adopts whatever it has already sent as delivered and writes the key, so a thread in flight across
an upgrade is not handed its whole answered history at once.

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

Every block has `{ id, round, kind }` and may carry the card fields (`Card` below). Content blocks
additionally carry the resolved snapshot — `text` (`html`, for an `html` block) and `sha` —
written once at post time and never re-read.

```js
{ kind: 'markdown', source: Ref|null, text, sha, html, anchors, error? }
{ kind: 'mermaid',  source: Ref|null, text, sha, error? }
{ kind: 'code',     source: Ref,      text, sha, lang, error? }
{ kind: 'html',     source: Ref|null, html, sha, error? } // path-only source: `lines`/`section` refused
{ kind: 'compare',  left: { label, block }, right: { label, block } }
{ kind: 'question', prompt, explainer?, explainerHtml?, context: [ContentBlock], widget, options: [Option], action? }

Ref    = { path, section?, lines? }               // lines is [from, to], 1-based inclusive
Option = { label, description?, preview? }                  // every widget except the one below
       | { label, description?, block: ContentBlock|null }  // widget 'choose-between-rendered-variants' only
widget = 'single' | 'multi' | 'text' | 'rank' | 'choose-between-rendered-variants'
Card   = { title?, status?: { label, tone }, summary?, summaryHtml?, details?, detailsHtml?, detailsLabel? }
tone   = 'good' | 'warn' | 'bad' | 'neutral'   // Card on any block, anywhere; a question refuses title, status and summary
```

A markdown block's `anchors` is markdown's own slug index for headings and top-level list items
(`kind: 'md'`, `ref`, `label`) — stored state that backs the `id` attributes in the emitted HTML,
and a different vocabulary from the comment `Anchor` below.

**`error`**: when a block carries `source` and `src/resolve.mjs` fails to resolve it (missing
file, out-of-range lines, section not found), the block holds the failure where its content
would be — `text` (`html`, for an `html` block) is `''`, `sha` the hash of the empty string, and
`error` a human-readable reason the page renders in place of the content. **A post carrying one
is refused whole** (ADR 112; see `POST /api/board` below for the refusal and its message), so a
new round never lands with this field set: it is what an already-stored board carries, and what
the page renders for a board minted before that rule. A block with no `source` never sets
`error`.

**`mermaid` blocks and `mermaid` fences in `markdown` are diagram input:** one that does not
parse refuses the whole post (ADR 117; see `POST /api/board`), including a diagram over the
page's own 50,000-character limit, while an engine failure that is not a parse failure fails
open.

**`html` may carry a `source`** (ADR 7), for an agent that renders a real page to disk rather
than re-emitting the bytes as generated tokens. It resolves through the same reader, confinement
and refusal behaviour as `markdown`, `code` and `mermaid`, under the html cap of 25,000,000 bytes
in place of their 512 KiB (ADR 121). It is the one
exception to what a `Ref` may carry: `lines` and `section` are refused, naming markup slicing as
the reason, and refuse the post with them. Cutting text at a line boundary still yields text;
cutting markup yields unclosed tags and orphaned `<style>`.

**An `html` stage may carry video**: a `<video controls>` whose source is a `data:` URI in the
stage's markup, or a `blob:` URL the stage's own script builds from inlined bytes, inlined like
every other stage asset. The `<video>` and its `aria-label` are written in the markup, and a
script sets only its `src`: the daemon resolves a comment against the stored markup while the stage
names the live element, so a video or a label a script creates leaves every comment on it lost. The page policy's `media-src data: blob:` admits those two and nothing
else, on a live board and on an archive opened from disk alike: no route serves media, and an
`http(s)` or relative source loads nothing. The clip counts toward the caps every stage lives
under (ADR 121): 25,000,000 bytes per `html` block, by value or by reference, and the same
25,000,000 across every `html` block in one post, each a 400 naming the cap; and 25,000,000 bytes
per request body, past which the daemon reads the body through, stores nothing and answers 413
naming the limit and the size it read. That holds up to 100,000,000 bytes: past it the daemon cuts
the connection with no answer, and the MCP shim refuses such a post before sending any of it, with
the same too-large message and nothing to restart. Every other block keeps 512 KiB.

**`explainer`** (ADR 111) is the question's own one-to-three-sentence lead-in: markdown by value,
optional, bounded by the same by-value cap as `prompt`, rendered as plain prose directly under the
prompt and ahead of the options. A caller sends `explainer`; the board stores that source verbatim
and stores the rendered markup beside it as `explainerHtml`, the same `text`/`html` pair a
`markdown` block keeps. Both fields are absent, not empty, on a question that carries none, and
that question renders with the prompt alone on its head row. It is a separate field from `context`
because the two sit in different places: the explainer takes the card's full row with the prompt,
while `context` is what the reviewer looks up, laid out beside the options.

**Card fields** give any block the shared card look: a title line, a status chip at the card's
right edge, one line of summary under the title and a details body folded closed. Each is
optional, on every block kind wherever it sits (top level, a compare side, a question's `context`,
a rendered-variant option's `block`), and absent, never empty, when not sent; a `null` counts as
not sent, and a board stored before these fields existed renders with them absent.

- `title`: plain text, 1 to 200 characters after trim, stored trimmed.
- `status`: `{ label, tone }`, the label plain text of 1 to 40 characters after trim, the tone one
  of `'good'`, `'warn'`, `'bad'` or `'neutral'`. A verdict goes here.
- `summary`: markdown by value, 1 to 600 characters after trim, stored trimmed beside its rendered
  `summaryHtml`.
- `details`: markdown by value under the same by-value cap as `prompt`, stored as sent beside its
  rendered `detailsHtml`, the same source/markup pair `explainer` keeps. The page folds it closed.
- `detailsLabel`: the fold's label, plain text of 1 to 60 characters after trim, only beside
  `details`; the page says "Details" without it.

A `question` refuses `title`, `status` and `summary`: its prompt is its title, its answer state
(Answered, Deferred) its chip and its `explainer` its summary. It may carry `details` and
`detailsLabel`. A field of the wrong type, empty or past its cap, a `detailsLabel` without
`details`, or a refused field on a question is a 400 naming the field, and the post stores nothing.
A ```` ```mermaid ```` fence in `summary` or `details` is diagram input like any other (ADR 117).
An amend into the open round stores them the same way.

**`action`** is `'fire'` or `'merge'`, on a `single` question only, and absent on one that carries
none: the question's yes is option 0, and while its round, its board's newest, waits on an
answer, the card of the mission whose board it is offers that yes as a Fire or Merge button. A click answers the round
through `POST /api/board/:id/submit`, that question set to option 0's label and the body marked
`via: 'card'`, exactly as a Send with that pick would. A `fire` question answered yes, from the
card, the page or a relay, records `fire` on the mission (the submit route below). Any other
value, or an `action` on another widget, is a 400.

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
or inside one of the configured reference roots*, and nothing else. The **spelling** does not
enter into it — one realpath check decides every reference, absolute or relative. Every violation
refuses the post that carried it (ADR 112) and never reads:

```
absolute path                        resolves wherever its relative spelling would: accepted
                                      inside the cwd or a root, refused like anything else
                                      outside both. A board with no cwd resolves an absolute
                                      path against the roots alone
realpath outside cwd and every root  refused (covers ../ traversal AND symlinks out)
the project directory itself         refused: a directory is never a reference target
not a regular file                   refused (a fifo blocks the daemon's only thread
                                      forever; a character device exhausts its heap)
larger than 512 KiB                  refused, before any of it is read (an html
                                      block's file: larger than 25,000,000 bytes)
line range past end of file          refused at BOTH ends (a trailing newline does not
                                      make a phantom last line)
```

The last three are decided on the **open file descriptor**, not on the path a second time: a
reference is opened exactly once, refusing to follow a symlink in any component while it does.
Which refusal comes back is decided only on names inside the boundary — a reference that does not
resolve inside it reports the same thing whether its target is absent, unreadable or simply
elsewhere, so a refusal is never an existence probe for the rest of the disk.

A confinement refusal **states the boundary and the ways across it**, because the post it refuses
is the only feedback the caller gets: the board's project directory, the reference roots in force
(none, when `CLAUDE_BOARD_REF_ROOTS` is absent), that a file in the project directory is named by
a path relative to it, that another directory is reached by adding it to `CLAUDE_BOARD_REF_ROOTS`
and running the installer again, and that the content goes up by value until then. Every one of
those is something the caller already supplied or configured; nothing in the message describes the
reference beyond repeating it, which is what keeps the rule above intact.

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

The same caps apply by value, 512 KiB to `text` and 25,000,000 bytes to `html` (ADR 121), and each
is a **400 on the post** either way now: by-value or by reference, the content came from the
caller, so there is a caller to tell. A `source` ref never raises a kind's cap — the whole file's
size is checked from `fstat` before any of it is read. The `html` blocks in one post also share
25,000,000 bytes between them, so a post naming several large stage files is refused at the one
that passes it, as a post carrying them by value is by the body limit.

### Answers, comments, anchors

**Commentable.** Only the rendered kinds are — `mermaid` and `html` — and they are wherever they
appear, including inside a question's `context` and inside a `compare` side. `markdown` and `code`
are not, anywhere. The rule is drawn on kind, never on position (ADR 28, which supersedes the
comment half of entry 26 and narrows entry 28).

```js
Answer  = { id, status, choice, note }
          // status: 'answered' | 'unanswered' | 'deferred'
          // choice: string (single, text) | string[] (multi) | string[] ordered (rank) | null
          // note is always present, '' when empty. unanswered is explicit, never a default --
          // with one widget-level exception: a rank always shows an order, so an untouched
          // rank list sends that order as `answered`, and only Defer leaves it open.

Comment = { n, blockId, anchor, text, createdAt, round, mintBlockKind }
          // mintBlockKind is the target block's kind at mint time, so an amend that
          // replaces a block with a different kind cannot silently re-point the anchor

Anchor  = { kind: 'block' }                       // whole block
        | { kind: 'dom',     ref, hint, time? }   // "N.N.N" child-index path + a composed hint;
                                                  // time: a video comment's whole second
        | { kind: 'mermaid', ref, domRef, hint }  // node id, plus the same path + hint; ref is
                                                  // the fallback, never the model. domRef/hint
                                                  // are absent on older stored anchors
```

`src/board.mjs`'s `ANCHOR_KINDS` no longer admits `md` (ADR 28). An `md` anchor stored by an older
client degrades to a whole-block comment, the same fallback an unrecognised kind always got.

An anchor of any kind that no longer resolves at render time is reported, not dropped: the comment
survives with `resolved: false` and a `lost` field naming what it lost (`src/board.mjs`'s
`lostLabel`) — the stored `hint` when there is one, the bare `ref` otherwise. This `resolved`/`lost`
pair is `resolveComment`'s own shape, read by the rendered page and the SSE-pushed client board
(ADR 28's element anchoring). The **Packet** below is the one consumer that drops `resolved` (ADR
99) and keeps `lost` alone.

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

**A comment on a `<video>` records its second.** The stage sends the video's `currentTime` with
the click, and the anchor stores it as `time`: whole seconds, floored, kept only as a finite number
from 0 to 86400 and dropped otherwise, never coerced from a string (`videoSecond`). The hint names
the second too, `" at m:ss"` (`" at h:mm:ss"` from an hour) after the composed hint, so the label
reads `"Criterion 2 clip at 0:07"` beside `time: 7`. A video's identity is its `aria-label`, else
its `title`, else `video`, never its fallback text (`videoIdentity`); an attribute name spelled
inside another attribute's quoted value is not that attribute. Resolution strips the suffix only
when it equals the stored `time`'s, and a timed anchor resolves only onto a `<video>`. An untimed
anchor on a `<video>` also resolves under the video's fallback text, the name a comment stored
before videos carried a second gave it. Another second on the same video is a different anchor, so
a sent comment at 0:07 leaves the video open to a comment at 0:12; the stage marks the video sent
only while it shows 0:07 (`sentTimes`). While comment mode is on the stage takes `controls` off
every video in its light DOM, the tree its own markup builds, that has them or gains them (a stage's
own script adding a `<video controls>` there or putting `controls` back), and gives them back to
those videos when it ends: a press on Chrome's native controls seeks without reaching the stage's
document, so nothing there could cancel it. The press then lands on the video itself and sends the
second it shows. A video inside a shadow root keeps its controls: a script built it, which the
markup rule above already rules out.

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
  status,                           // 'posted' | 'submitted' | 'discuss' | 'timeout' | 'abandoned' | 'error'
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, lost? } ],
  url,
  relayed?,                         // { words, at }: answered by a relay, not a Send
}
```

`relayed` is present only on a round the Master Chief answered on the PM's typed words
(`POST /api/board/:id/relay` below); the text channel says so in a `Relayed:` line carrying the
words.

No `resolved` (ADR 99): it read as review state to every packet consumer, and duplicated `lost` —
false exactly when `lost` is present. A comment whose anchor is gone still carries `lost`, naming
what it lost, exactly as above; a consumer that used to branch on `resolved === false` branches on
`lost`'s presence instead.

`posted` means the round was not *awaited* (`round.awaited`, CONTEXT.md "Awaited"): it carried
no question block anywhere in it — top-level, or nested in a question's `context` or a `compare`
side — and it was not a page board (one `html` block, nothing else) posted with `wait: true`
(ADR.md entry 45) — so there was nothing to submit and the shim returned the instant the post
succeeded rather than waiting at all. A `posted` packet carries `answers` and `comments` only on
the drain path `noWait` opens (`POST /api/board` below): what the thread is owed and no packet has
carried rides that one response, each entry naming its own round. Without the field, and on a
daemon older than it, both arrays are empty. `discuss` means the reviewer chose Discuss in chat:
partial answers are included and the agent must stop posting boards for the rest of the session.
`timeout` is the wall-clock cap (default 40m, ADR.md entry 47) and carries an explicit no-response about ITS OWN
round — an empty `answers` and no comments of its own — plus whatever the two exceptions below
owe the thread, which are owed to a timed-out round exactly as they are to any other. `abandoned`
is the round being closed under a blocked call — the
conversation that owned the board declared itself over (`fresh`, ADR.md entry 69) or the board was
abandoned directly — and it is terminal in a way `timeout` is not: the round will never reopen, so
the caller posts to the current board rather than to this one. It carries whatever the store held
plus the same owed comments and answers, and the shim names it as its own outcome, never as a
submit.

**Scope: one packet is one round, with two exceptions.** `answers` holds exactly the question
blocks whose `round` is the packet's `round`, and `comments` exactly the comments left in it.
Round 6 does not redeliver rounds 1-5: the agent would re-address settled feedback and re-report
an old `unanswered`/`deferred` as a fresh signal, louder each round. Every entry carries its own
`round` (and each comment its `createdAt`), so a caller that wants the thread's history reads
`board.answers` / `board.comments`. The stored board keeps everything; the packet is the round.

Both exceptions are the same rule — **what no packet has carried is owed to the next packet the
same thread returns, once** — and both are additive: they append to the array the packet already
built, are told apart by the `round` every entry carries, and change nothing about the packet's
shape, so a consumer that has never heard of either keeps working unread. "Once" means committed
as delivered only after the response has actually left the daemon, so a dropped connection
re-delivers rather than loses, and what has been delivered is never sent again. They ride whatever
packet comes next, `timeout` and `abandoned` included. `GET /api/board/:id/read` is not a packet
and marks nothing (ADR 115), so what it returned is still owed: the same entry can ride a later
packet too, and the `round` every entry carries is what tells a caller it is looking at an answer
it already has.

**The first exception: a comment left on a round that is not *awaited*** (ADR.md entry 35, narrowed by
entry 45). A page board posted without `wait: true` is a round nothing ever waits on, so nothing
would otherwise carry its comments back — the reviewer's feedback on the artifact would sit in the
store unread. Such a comment rides the next packet the same thread returns, once, appended to that
packet's own `comments`; it carries its own `round`, which is how a caller tells it from the round
in hand. Collecting comments from a page board therefore costs either `wait: true` on
it, so it gets its own `/wait` call and its own `submitted` packet with `comments` populated
directly (an empty array there is a normal outcome, not this exception), or a later round that
asks something — an agent that wants them one way or the other rather than polling for it.

**The second exception: the answers of a submitted round no packet ever carried** (ADR.md entry
107). A round whose wait died and which the reviewer then submitted anyway is the shape this
exists for: a lapsed round stays `open` (ADR.md entry 50), so the submit lands and is persisted,
but that round can never hand a caller a packet again and the rule above stops any later one
carrying it. The agent is left holding a `timeout` packet claiming an explicit no-response the
store has since falsified. A round whose own response died on the wire loses its answers the same
way. So a `sent` round whose answers no packet has carried has them appended to the next packet
the same thread returns, each entry naming its own `round` exactly as it always did. A round
answered through its own `/wait` is never redelivered this way — that packet leaving is precisely
what marks it — and no packet ever carries the same answer entry twice.

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
GET  /                             the Missions view, the board's home page (ADR 124);
                                    `/?q=` is a 302 to `/boards?q=`, where that filter lives
GET  /boards?q=                     the Boards view: the list of Threads, filtered to sessions
                                    matching q
GET  /b/:boardId                    the served page
GET  /b/:boardId?stages=held        the same page with every stage frame empty and
                                    held (ADR 122): a tab's own catch-up read, see
                                    "SSE events"
GET  /b/:boardId?stages=<sha>,...   the same page with every stage held but those
                                    named: a tab's fill of the frames a push left held
GET  /b/<asset>                     the shared script or stylesheet a page names, by
                                    content-addressed filename (ADR.md entry 70); the
                                    daemon's only static route. Disjoint from the line
                                    above: an asset name contains a dot, which a board id
                                    cannot. `mermaid-<hash>.js` alone is open (the caller
                                    is a sandboxed stage, which holds no credential);
                                    `ui-`/`styles-` are gated like every other read
GET  /api/health                    { ok: true, version, daemon, pid }  (open: install.sh polls it)
GET  /api/probe/documents           { ok: true } or { ok: false, code } -- whether macOS lets
                                    the daemon open a file under ~/Documents (install.sh asks
                                    it after the health gate). A code, never a name
GET  /auth/:token                   consume a handoff -> 302 + Set-Cookie  (open by necessity)
POST /api/handoff                   { boardId? } -> { token, expiresAt, ttlMs }
POST /api/board                     post a board or a round into a live thread
                                    -> { boardId, thread, round, url, clients, suppressed,
                                    awaited }, plus { answers, comments } on a post that
                                    carried noWait (see the section below)
GET  /api/board/:id/wait?round=N    blocks until the round is sent -> Packet. Secret only:
                                    never cookie-reachable -- `handleWait` also writes
GET  /api/board/:id/read            one board's rounds, answers and comments, in packet
                                    shape (ADR 115) -> { board, thread, title, url, rounds,
                                    answers, comments }. A pure read: nothing is marked
                                    delivered and nothing is written, so the same call twice
                                    answers the same twice. Secret only, like /wait: a tool
                                    calls it, never a page
GET  /api/board/:id/events          SSE: round pushes, state changes; `?stages=held`
                                    declares the page fills held stage frames
POST /api/board/:id/submit          { round, action: 'send'|'discuss', via?: 'card', answers,
                                    comments }
POST /api/board/:id/abandon         {} -> { ok: true, rounds }; closes every round still
                                    open on a board a conversation walked away from
                                    (ADR.md entry 69). Secret only: never cookie-reachable
POST /api/board/:id/attended        { watcher, attended, seq?, sinceFocusMs? } -> { ok: true };
                                    the open tab reporting whether it is Attended right now
                                    (CONTEXT.md "Watcher", "Attended"); stores nothing
                                    durable itself, but a report that the reviewer has
                                    returned withdraws the stranded banner recorded on that
                                    board and opens its return gate
GET  /api/index/rows?q=             -> { html }: the index's thread rows, filtered by the
                                    same q, and nothing else -- no page, no styles, no
                                    board content. What an open index fetches on its own
                                    fifteen-second tick, and again on a `waiting` push over
                                    the daemon-wide stream (ADR 77, amended by 87), to
                                    patch the list in place; the rows are rendered by the
                                    same function `GET /boards` uses, so the two cannot drift
GET  /api/search?q=                 archive search
GET  /api/waiting                   every round in the store with an OPEN WAIT (not merely
                                    unanswered, and not "stranded") ->
                                    { waiting: [{ boardId, thread, title, round, url }],
                                      total, now, missions?: { needsYou, working } };
                                    newest board first, uncapped -- a client showing only
                                    its first few owns that cap. `missions` counts the
                                    missions and tab cards needing the PM (ADR 131) and
                                    the missions working, for the
                                    Status item's missions row; absent when the missions
                                    read fails, never failing the list
GET  /api/events                    SSE: the daemon-wide stream -- timer, settings,
                                    waiting-count and mission changes, for a process or page with no
                                    single board id to subscribe under
                                    `/api/board/:id/events` with (bin/menubar.m; the index
                                    page, src/indexpage.mjs, ADR 87). See "SSE events" below
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
                                    bannerLevel?, menubarCountdown?, menubarHidden?,
                                    cueWork?, cueBreak?, cueLongBreak? }
                                    merged into the stored settings, not replaced;
                                    bannerLevel is one of off|no-board|this-board|always
POST /api/pomodoro/preview          { cue } -> { ok: true }; plays a cue immediately, reads
                                    and writes nothing
POST /api/pomodoro/notifyTest       no body -> { ok: true }; raises one test banner
                                    immediately, reads and writes nothing
POST /api/store/prune               { days } -> { ok: true, boards, assets, missions }, the
                                    counts removed. Deletes every board older than `days`
                                    (document and page) plus every shared asset no
                                    surviving page or asset names, and every mission
                                    retired 30 days or more ago, whatever `days` says. `days` is REQUIRED and never
                                    defaulted: a call without it is a 400. The only
                                    route that deletes a board, and nothing but a click
                                    in the index's settings panel calls it (ADR 71)
POST /api/board/:id/relay           { round, answers, words } -> { ok: true, board, round };
                                    a submit on the PM's relayed words (ADR 126). Secret only
GET  /api/missions?all=1            every mission's view, with counts -> see "The missions
                                    routes"; the cookie reads it too
GET  /api/mission/:key              one mission's view. Secret only
POST /api/mission/:key              write a mission's whitelisted fields
POST /api/mission/:key/launch       { phase, login?, prompt? }: reserve its one live session,
                                    or queue it
POST /api/mission/:key/session      { pid?, id?, name?, login? }: bind or heartbeat
POST /api/mission/:key/order        { kind: 'stop'|'comment', text? }: a card's order; the
                                    cookie may post it
POST /api/mission/:key/order/:id/ack
                                    {}: the order was relayed
POST /api/sessions                  { intervalMs, sessions }: the session watcher's full
                                    snapshot, held in memory -> see "The session routes".
                                    Secret only
POST /api/session/:id/order         { kind: 'stop'|'comment', text? }: a tab card's order;
                                    the cookie may post it
POST /api/session/:id/order/:oid/ack
                                    {}: the order was relayed. Secret only
```

Posting and waiting are separate routes on purpose, so splitting `ask` into post + collect stays
cheap.

**Four gates, in order:** loopback `Host` (403), same-origin on every non-GET (403), a credential
on every non-GET -- plus the three GETs held to the secret alone (401): `/wait`, because it also
writes, and `/read` and `GET /api/mission/:key`, because only a tool ever calls them -- and a credential on every other GET but
two (401, secret or cookie). Both credential gates are written
as "everything, minus an explicit exception list", so a route added later is gated by default
rather than by whoever adds it remembering.

The Host check does not cover a browser: a page on any origin doing
`fetch('http://127.0.0.1:7391/...')` has its `Host` set to loopback by the browser itself. So
every non-GET additionally refuses (403, no body) when `Origin` is present and is not the daemon's
own origin, or when `Sec-Fetch-Site` is present and is not `same-origin`, and every body must be
`Content-Type: application/json` (415 otherwise) and at most 25,000,000 bytes (413 naming its size
and the limit; past 100,000,000 the connection is cut with no answer). Non-browser clients (the
shim, curl, the checks) send neither header and are unaffected. Every HTML response also carries
`X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP.

The two credentials and every route with rules of its own carry them in their own sections, below.

## The local secret

```
~/.config/claude-board/secret      0600, in a 0700 directory; 32 random bytes as hex
                                   generated by install.sh, NEVER rotated by a reinstall
                                   (CLAUDE_BOARD_SECRET_FILE relocates it, for the checks)
x-claude-board-secret: <secret>    request header; the file is re-read per gated request,
                                   which is what makes rotation revoke; compared with
                                   crypto.timingSafeEqual, length-guarded
```

**Every non-GET request** must carry it — except `POST /api/board/:id/submit`,
`POST /api/board/:id/attended`, `POST /api/store/prune`, `POST /api/mission/:key/order` and
`POST /api/session/:id/order`, which also take the session cookie below. `POST /api/board/:id/abandon` is deliberately **not** among them: only the
shim that owns a board may close its rounds, never a browser looking at it. A missing or wrong
credential is **401 with no body**: nothing about
what is behind it, not even whether the board exists. A daemon that finds no secret file says so
on stderr at startup and refuses everything gated: it fails closed, never open. `bin/mcp.mjs`
reads the secret at startup, sends it on every call, and refuses every tool call it has, `read`
included (naming `./install.sh`, writing nothing, and naming the tool it refused), when it has
none or the daemon answers 401. `SECURITY.md` carries
why a local secret exists at all.

## The browser session cookie

**Every route but `GET /api/health`, `GET /auth/:token` and `GET /b/mermaid-<hash>.js` requires a
credential**, reads
included -- except `GET /api/board/:id/wait`, which this cookie alone never satisfies (secret
only, above). The browser cannot read a 0600 file, so it holds this instead:

```
Set-Cookie: cb_session=<HMAC-SHA256(secret, "claude-board/session/v1")>;
            Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict
```

Host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, and **not** a session cookie: a bookmarked
board opened days later has to work. No `Secure`, and not because it would be ignored: Chrome treats `http://127.0.0.1` as a
potentially-trustworthy origin and *does* return `Secure` cookies to it. It is omitted because on a
loopback-only plain-http daemon it buys nothing, and would break any browser that does not
implement that carve-out (`src/secret.mjs` records the same correction).

**Derived from the secret, not random**, which is what makes it survive a daemon restart: any
daemon holding the same secret accepts the same cookie, so `launchctl kickstart`, a crash and a
code reload are all invisible to an open browser. Rotating the secret invalidates every browser at
once — intended.

Its strength over boards, precisely: "may read every board and answer any open round" — plus the
two additions below, which reach past that. It is refused in the
`x-claude-board-secret` header, so it can never create a board and therefore never make the daemon
resolve a file. It is **not** scoped to one board.

It is additionally accepted on `POST /api/board/:id/attended` — a browser holding the cookie is the
only party that can honestly report whether its own tab is Attended, and the report reaches less
than `submit` already does: no round named, no answer carried, nothing durable touched (see that
route's own section, below).

It is additionally accepted on nine pomodoro writes — `ensure`, `pause`, `resume`, `reset`,
`settings`, `preview`, `notifyTest`, `forward`, `restart` — so the index page's switch and its
settings popover can drive the clock. The clock itself never gates an `ask` and never reaches a
tool. **`settings` is the one that reaches past the clock**: `bannerLevel` lives in the same
document, it is merged in and persisted like any duration, and the Stranded rule reads it back
before every announcement, so `bannerLevel: 'off'` from a cookie durably suppresses the Stranded
banner for every board on the machine, across restarts. `SECURITY.md` "What the cookie may write"
prices that. The list stays a closed, named set: a pomodoro write added later is secret-only until
someone deliberately names it — and one that reaches a board the way `settings` does needs that
priced before it is named.

## Authorizing a browser

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

## Refusing a caller with no credential

**401, one status code everywhere.** No `WWW-Authenticate` header: it would raise a browser
password prompt in front of the page that explains the actual fix, and there is no password to
type.

A **browser navigation** (a path outside `/api/` whose `Accept` includes `text/html`) gets an HTML
page naming the recovery command verbatim. Everything else — `/api/*`, the SSE stream, curl, the
shim — gets `{ error, recover }` as JSON and no markup. Neither reveals anything about the store:
the same page is served whether or not the board exists.

## `POST /api/board`

`{ title, blocks, cwd?, thread?, wait?, noWait? }` starts a new thread;
`{ boardId, blocks, title?, wait?, noWait? }` pushes into a live one. `cwd` is only meaningful on
the thread-creating form. `title` is meaningful
on **both**: on the `boardId` form it labels the round being minted or amended. `wait` (boolean,
default `false`) is meaningful only on whichever call actually MINTS the round being posted — an
amend never mints one, so `wait` on an amending post is inert (the round it would apply to was
already stamped `awaited` when it was first minted, per the paragraph above naming
`awaited`/`awaitDeadline`). It sets `round.awaited` together with the question-block check
already run on the same blocks: see "Round `awaited` / `awaitDeadline`" above.

**`mission` (a mission key, either form) links the board to that mission** (ADR 123): the daemon
appends `{ id, url, at }` to the mission's `boards`, `url` the one this post's reply carries,
making a stub mission (titled by its key, phase `grill`, state `waiting`) when there is none, and
stores `mission` on the board. A later round naming a mission links a board that had none; a
board never moves from one mission to another, so naming a second is a **400**, and so is a key
off the pattern, both before anything is written. The shim sends it from `CLAUDE_MISSION`.

**`session: { pid, procStart }` (either form) names the agent session posting** (ADR 131): the
process id of the agent session the shim runs under, and that process's start, UTC ISO-8601 to the
second (`2026-10-29T12:10:15Z`, milliseconds allowed). Any other shape (a pid that is not a
positive integer, a start with an offset or no zone, another field) is a **400** before anything is
written. The daemon keeps `session: { pid, procStart, id }` on the board, `id` the session id of
the one listed session ("The session routes") with that pid and start, else `null`; the post never
names an id itself. The first post to name a session decides the board's: a later post from the
same pid and start fills an `id` still `null` or takes its new one (the session resumed in its own
process), a post resolved to the same `id` from a new process takes its pid and start, and any other
post moves nothing (and still lands). Starts match to the second. An open round on the
board then puts that session's tab card in Needs you. The shim sends its parent process (the
`claude` process that spawned it) and that process's start as `TZ=UTC ps -o lstart=` prints it,
read once at startup; a start it cannot read sends no `session`, never a failed post.

**`noWait` (boolean) is the caller stating it will not open `/wait` on this post**, which is what
makes the response the thread's next packet. On it the daemon drains into that response whatever
the thread is owed and no packet has carried (an answer sent after an earlier round's wait ended,
every undelivered comment, the amended round's own included), so the body carries `answers` and
`comments` beside its usual fields, once. The FIELD decides and the daemon's own `awaited` verdict
does not: the two sides can disagree about whether a post is awaited, and a shim from before the
field never sends it, so an old shim can never mark delivered what it did not return. A post the
shim then waits on carries no `noWait` at all and is never drained twice.

Pushing into a live board **amends** the latest round in place — a block whose incoming id
already exists on the board replaces it, everything else is appended to that same round — while
that round is still `open`, **carries a question block somewhere in it**, and **its own wait has
not lapsed**. Otherwise it mints a new round. A wait-lapsed round stays `status: 'open'` forever
(only a submit or an abandon moves `status`), so `open` alone would send every later question in
the conversation into a round nothing is listening to.

**A reference that does not resolve refuses the whole post** (ADR 112): a **400** carrying one
message per failed reference — every one of them, wherever it sits (top level, a question's
`context`, a `compare` side, a variant option) — in the shape "Reference confinement and caps"
above describes, and nothing is stored, rendered, broadcast or pushed. The refusal is decided
during normalisation, before the board document is written or amended, so a refused post leaves
the store exactly as it was: the same post with the reference fixed lands normally, and a round
already open on another board stays open. This is what replaced landing the round with a
"could not resolve" note on the reviewer's page while the caller got a 200 and never learnt.

**A diagram that does not parse refuses the whole post** (ADR 117): the daemon checks every
by-value or referenced `mermaid` block, and every `mermaid` fence in a by-value or referenced
`markdown` block, wherever it sits in the block tree. Its **400** carries one message per
failing diagram, joined with any reference-refusal messages: the block id, the question and
context position, or the fence's ordinal and its referenced file; the page engine's first error
line and line number; and the ways out, fix the source and post again, or post an unfixable
fence by value with its language changed so it renders as code. The same page engine runs in a
sealed VM context; a diagram over the page's own 50,000-character limit is refused before it
parses, while a non-parse engine failure is logged and fails open. Nothing is stored, rendered,
broadcast or pushed, and the same rule applies on an amend, leaving its stored round unchanged.

Either way the response is `{ boardId, thread, round, url, clients, suppressed, awaited }`, plus
`answers` and `comments` on a post that carried `noWait: true` (below) and on no other, `round`
naming whichever round was amended or minted and `awaited` carrying that round's own minted
`awaited` flag. The flag is on the response because the daemon is the only side that has seen the
normalised round: the poster checks the raw blocks it sent, which is a different question (the
case that first split the two answers — a page board whose `html` `source` failed to resolve, minted
*not* awaited — is a refusal now rather than a round). A caller deciding whether to wait should
prefer this field and fall back to its own shape check only when it is absent (a daemon older than
this field).

**`suppressed`** answers whether this *board's* auto-open was Suppressed (CONTEXT.md "Suppressed";
ADR.md entry 91), in which case a caller that would otherwise open a tab must not, and the stranded
banner announces the board instead. One condition, taken at the instant the board is created:
some board on this daemon — any board, any project, focused or not — already has a Watcher. The
round-banner level (`bannerLevel`, "Pomodoro settings" above) does not enter into it:
suppression trades the tab for a banner, so the one banner a Suppressed board's first round is
owed fires at every On level, whatever that level's own attendance condition says about ordinary
stranded rounds. `bannerLevel: 'off'` is the one level that silences it too (ADR 106): the
reviewer asked for silence in as many words, and the Popover's Waiting list is what remains. A Watcher whose
tab has gone does not count: the test is a subscription this daemon can still write an event to,
not merely one it has not yet reaped.

Decided on the call that mints the board and never re-decided by a later one; a Watcher arriving
afterwards does not retrospectively suppress an open that already happened. It is recorded on the
board document as `suppressed` and stripped from everything a client sees, like `strandedBanner`
beside it, because the stranded rule reads it back long after the response is spent — and that rule
**spends** it the first time a Watcher reports the board focused, since a board the reviewer has
reached needs no banner telling them it exists. A push into a board reports the stored value, which
is therefore false once it has been visited; only a thread's first board consults it at all. A
daemon older than the field omits it, and a caller then opens exactly as it always has.

A **retry** carrying a `requestId` this board has already applied is answered from what that id
already did (`deduped: true`) while the round it guarded is still `open`, **its wait has not
lapsed**, **and the content that round resolved has not changed on disk**. A round whose
`awaitDeadline` has passed can never hand a caller a packet again, so it is never the answer to a
retry: the post falls through and mints the next round, against a live deadline.

The content gate is what makes `requestId` an identity over what a round *resolved to* rather than
over the bytes of the request. `requestId` is derived from the raw blocks, and a raw block names a
file by **path**, so "post an artifact, regenerate the file it references, ask again" re-sends a
byte-identical body: keyed on the body alone, the reviewer keeps seeing the old snapshot while the
caller is told the new one landed. On a retry the daemon re-resolves the guarded round's
`source` blocks and compares each against the `sha` it snapshotted; any difference makes this a
different request. By-value content needs no such gate: it travels in the body, so changing it
changes `requestId`.

A retry refused by any of those three gates **mints the next round**. It is never amended into the
round it was refused against, even when that round is open and asks something: appending would
leave the reviewer one round holding both snapshots and both copies of the question, and the packet
reporting two answers for the one question that was asked.

The question is what makes a round amendable, because amending exists for one situation: the agent
is still assembling a round the reviewer has not answered yet. A round that asks nothing is
complete the moment it lands — nothing can ever answer it, so it stays `open` for good — and a
later post is a new round beside it, not an edit of it. That is what makes "post the artifact,
then ask about it" two rounds, and therefore two pages one flip apart.

A board can consequently hold **two open rounds at once**: an artifact round nobody will ever send,
and the question round after it. Wherever this protocol says *the open round*, the round an amend
lands on, it means the **latest** open one. A submit is not bound to it: it names the round of the
page the reviewer sent from, which may be any unsent round (ADR 134).

## `POST /api/board/:id/submit`

```js
{
  round: 1,                                       // required; the round of the page the
                                                  // reviewer sent from; any unsent round
  action: 'send' | 'discuss',
  answers:  [ { id, status?, choice, note? } ],   // status defaults to 'answered' when
                                                  // choice is present, 'unanswered' otherwise;
                                                  // any question block with no entry here is
                                                  // synthesised as unanswered server-side
  comments: [ { blockId, anchor, text } ],        // n, createdAt, round assigned server-side
  via: 'card',                                    // optional: sent by a mission card's
                                                  // Fire or Merge, absent from the page
}
```

`round` names the round the page believed it was answering when the reviewer pressed the button:
the page on screen. Send's check, its count of questions left and the answers it posts cover that
page alone; another unsent page keeps what was typed on it and sends from its own page.
Omitting it is a **400**; naming a round that has already been **sent** is a **409** whose body
carries `{ error, board, round }`, `round` naming the latest round still unsent (`null` when every
round has gone out, which is also what a submit naming no round at all is answered with). Without
it, a second tab — or a plain double-click, since the send bar sits outside the round section and
so is never disabled by the history collapse — appends the same comments a second time under fresh
numbers and re-applies answers to a round that already went out. A 409 means "already sent" and is
not an error state.

`action` is the whole difference between the two ways out of a round, and the body is otherwise
identical, because `discuss` is defined as returning *whatever is filled in*, not a degraded
second path:

- `'send'` → `board.state = 'submitted'`, packet `status: 'submitted'`.
- `'discuss'` → `board.state = 'discuss'`, packet `status: 'discuss'`; partial answers are
  included and the calling agent must stop posting boards for the rest of the session.

**Not sent, rather than still open** (ADR 114): a round nobody has answered takes a Send however
the agent's wait ended. A Lapsed round (still `status: 'open'`, ADR 50) always did; an
**abandoned** round does too, and `applySubmit` marks it `sent` from whichever state it was in. Its
answers are then owed to the thread's next packet, or collected by `read` above, which is the only
path an abandoned board has, since no wait ever returns to it. The page says as much rather than
hiding it: the round keeps its widgets and its Send bar live (`historical` in `renderRoundSection`
is `sent` alone, server-side too, so a reload takes nothing back), and the pill still reads
`read-only`, with a hover text promising that comments and answers sent here are saved and reach
the next agent that reads the board. A page board's comment panel is the one exception: it renders
only while a wait is open on its round (`renderPageCommentPanel`), so an abandoned page round
shows its comments and no compose form, exactly as a lapsed one does.

The page renders both as buttons in one `.send-bar` (`#send-btn`, `#discuss-btn`), which
`body.readonly` hides wholesale — so the standalone `file:` archive offers neither.

**A Fire records itself on the mission.** When the round just sent holds a `single` question
carrying `action: 'fire'` answered with option 0's label, and its board is linked to a mission
(`board.mission`), the submit writes `fire: { at, by }` on that mission, `at` the daemon's time
and `by` `'card'` for a body carrying `via: 'card'` (the mission card's click), else `'round'`. It
is the board's own write, so a Fire reaches the mission whether or not the grill session that
asked is still alive to copy it, and `missions` goes out on the daemon-wide stream. Any other pick,
or a `merge` question, writes nothing. A mission record that cannot be read or written is warned
and the submit still answers 200, the round sent. A repeat on the sent round is the 409 above, so
one round writes `fire` once.

## `POST /api/board/:id/relay`

```js
{
  round: 3,                                       // required, an integer: the round answered
  answers: [ { id, status?, choice, note? } ],    // as a submit carries them; default []
  words: 'yes, merge it',                         // required: the PM's words, verbatim
}
  -> { ok: true, board, round }
```

Secret only; on no cookie list, so a browser cannot forge one, and answers through `submit`
instead (ADR 126). The Master Chief answers a session's open round on the PM's own words, typed to
it rather than on the page. It is a submit with `action: 'send'`, through the submit route's own
path, so everything above holds: the round is sent, its tabs are pushed, a waiting `ask` wakes,
`waiting` and the mission's `missions` go out on the daemon-wide stream, a Fire is recorded on the
mission with `by: 'round'`, and a question with no entry in `answers` is unanswered. The round then records `relayed: { words, at }` (`at` the
daemon's ISO time of the relay), carried by every packet and `read` of it; the shim's text channel
says so on its own line, `Relayed: the Master Chief answered this round on the PM's words at
<at>: "<words>"`.

Refusals, each writing nothing: a body that is not an object, `words` missing, empty after trimming
or over 1 KB in UTF-8, `round` not an integer, or `answers` not an array is a **400**; an unknown
board is a **404**; a sent round is a **409** as for a submit, and so is an **abandoned** one,
which a Send would still take (ADR 114): its conversation walked away, so nobody waits on the yes,
and a successor reading the board later must not find an approval meant for a session that is
gone.

`relayed` proves which path answered, not who typed the words: any process of this user holding
the secret could post a relay, as it could already post a submit.

## `POST /api/board/:id/abandon`

```js
(no body)  -> { ok: true, board, closed: [1, 2…] }
```

The shim declaring that the conversation which owned this board is over (ADR 69; `fresh` on `ask`,
"MCP surface" below). Every round still `open` on the board is closed — `status: 'abandoned'`,
`awaited: false`, `abandonedAt` stamped (see "Board document" above) — and `closed` names them, or
is empty when there was nothing left open. Idempotent by construction: a second call finds no open
round and closes none. A board id that names nothing is a **404**.

The board document and its `pages/<id>.html` are both rewritten, unlike the `/wait` timeout branch
which writes only the document: this is the last write an abandoned board will ever get, and since
ADR 114 what it has to carry is the opposite of what it once did. The round keeps its widgets and
its Send bar live in the stored page, because a reviewer who reloads after the abandon can still
answer and that answer is stored (`POST /api/board/:id/submit` above); freezing the page would
freeze away the one path an abandoned board's answers have. `awaitExpired` is broadcast
once per closed round, the same nudge and the same event a wait dying of its own clock sends.

**Secret-only.** It is off `BOARD_COOKIE_ACTIONS`, so the session cookie does not reach it and a
browser cannot close a round it is looking at. The only caller is the shim that posted the board,
naming the board id it holds in its own memory — which is what scopes this to the declaring
session: nothing here reads `cwd` or `thread`, so two sessions in one project directory cannot
touch each other's boards.

Closing the rounds is also what takes the stranded Banner down: the rule is told the board was
abandoned, which cancels a grace still counting down and withdraws a banner already on screen by
SIGTERMing the process serving its click. Nothing can re-arm it, because only a round landing on
this board could, and none ever will. Abandoning is NOT returning: the announcement mark and the
return gate are left exactly as they were, so this withdraws a banner without ever buying another
one (ADR.md entry 74).

## `POST /api/board/:id/attended`

```js
{ watcher: '<id from the stream's own "watcher" event>', attended: true | false,
  seq?: 0, 1, 2…, sinceFocusMs?: 0, 1, 2… }
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

`sinceFocusMs` is how long ago the TAB last had focus, and it exists so the two-minute look-away
window (ADR.md entry 73) survives an SSE reconnect. The daemon's own record of when a tab last had
focus lives per Watcher, and a reconnect mints a fresh one — so a buried tab's first report through
it would otherwise read as "never focused", the window would read as spent, and the bare grace
would be armed under a reviewer who looked at that board thirty seconds ago. It seeds the stamp
only when the daemon has no observation of its own, so a report can never extend a window already
running, and a tab that has never had focus does not send the field at all. Optional and validated
exactly as `seq` is; a value old enough to be spent lands as an expired window, not an error.

It is the page's own claim, like `attended` beside it, and the same write credential reaches both.
It is not merely a weaker `attended: true`, though: a seeded window holds a banner back WITHOUT
opening the return gate, where a report of `attended: true` opens it. So the two differ in kind
rather than in degree — one is a quieter state, the other a louder one — and a forged report can
buy silence either way. What neither can buy is a second banner for a round already announced,
which is the mark's business and not this route's.

Cookie-authenticated exactly like `submit` (see "The browser session cookie" above): a browser
holding a live stream on this board is the only party that can honestly answer this question, so an
unauthenticated report is refused rather than believed. What a forged one would buy an attacker:
`SECURITY.md` "What the cookie may write".

What it stores is a fact about a live SSE connection and nothing about the board. It is not,
however, a route with no durable consequence: the stranded rule reads that fact immediately, and a
report that the reviewer has RETURNED opens the return gate on the banner record standing on the
board — one read and one write, and for a page board that document can be large. That is the price
of a mark that survives a restart, and it is paid once, only when the reviewer really comes back to
a board that had been announced; every later report on that board, and every ordinary report on any
other, writes nothing. A report naming a `watcher` this board has no live
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

## The stranded banner

The daemon raises one native notification for a board no Watcher is looking at, carrying either an
open awaited round or — when its own auto-open was Suppressed — its first round, awaited or not
(CONTEXT.md "Stranded"; ADR.md entries 55, 58 and 92). The second half is what covers a Suppressed
content-only board, a page board posted without wait: nothing on it is awaited, no tab was opened
for it, and without the banner it would land in silence. It is spent on round 1 and only round 1,
so it can never buy a board a second banner; it is spent outright the first time the reviewer
reaches the board, so a board opened and closed is never announced afterwards; and it covers only a
round that never carried an `awaitDeadline` at all, so a round whose wait has *lapsed* — which
keeps `status: 'open'` for good — stays the awaited case and is not announced as a content-only
one. A first round already abandoned earns none of it either. The mark is per round and
permanent for the life of that round (ADR.md entry 74) — narrowed by one exception (ADR.md
entry 97): an amend to the round the mark currently names moves the mark back to that round's
number minus one, with the gate forced open, so the amended round is watched exactly like a new
one and may ring again for content the reviewer has never seen. Moved, never cleared outright —
a board can carry more than one awaited-open round at once (an awaited page round beside a later
question round, ADR.md entry 45), and clearing the mark to nothing reopened every round at or
below the one just amended, not only that one, so an OLDER round already announced rang a second
time while the round actually amended stayed silent. And gated on the board being genuinely
unattended when the amend lands: one the reviewer is currently on, or inside its look-away
window, is left entirely to the ordinary Attended/return-gate handling below, which needs the
mark undisturbed to open the gate on. It is re-decided after
every event that can change the answer — a round landing, a Watcher arriving or leaving, an
`attended` report, a submit, an amend to an already-open round — never polled, and it fires
after a grace of 5000ms (`CLAUDE_BOARD_STRANDED_GRACE_MS` overrides, and the launcher passes
it through), so a tab that is merely reconnecting, or one about to open on its own for the
thread's first round, is never mistaken for an absent reviewer.

A board is Attended while a Watcher reports its tab focused, **and for two minutes after that tab
last had focus** (`CLAUDE_BOARD_ATTENDED_WINDOW_MS` overrides, and the launcher passes it through;
ADR.md entry 73). A tab that is focused right now has no clock on it at all, however long it sits
there — there is no idle detection, and nothing reads the reviewer's keyboard. Because no event
fires when a window expires, the grace a board is armed with is the grace *plus* whatever is left
of that window. The window is per Watcher and dies with the tab, so closing the last tab strands
the board on the bare grace; it survives a reconnect only because the page reports `sinceFocusMs`
with every `attended` report, and a fresh Watcher seeds its stamp from that rather than from the
fact of being connected.

One banner per **round**, once, ever (ADR.md entry 74) — unless that exact round is later amended
while the board is unattended, which moves the mark back one and lets it ring again for the
content that changed (ADR.md entry 97); an amend while the board is Attended does not. Further
rounds landing on a board that has announced anything add nothing, and neither does the announced
round being answered, abandoned or lapsing — a round becoming the oldest waiting one is not a
reviewer coming back. Returning takes the banner
off the screen and lets the board announce a round it has never announced; it never un-announces
the round already marked. The click carries the board's own URL plus the `#stranded-round`
sentinel, which resolves to the oldest round still waiting at the moment it is clicked (not
`#open-round`, which resolves to the newest open round and belongs to the index's live-row links).
The URL is built from the socket the daemon is bound to and never from the `Host` header, and the
bound port crosses to the launcher as its own argument so the two can be checked against each
other.

The banner is recorded on the board document as `strandedBanner`,
`{ at, until, round, returned, pid } | null`: when it went up, when the process serving it will exit
and withdraw it (the round's deadline or the launcher's hard ceiling, whichever is sooner — a
Suppressed board's content-only first round has no deadline at all, and that ceiling alone bounds
it), the highest round announced — the **mark**, permanent for the life of that round unless an
amend to it moves it back one (ADR.md entry 97) — whether the reviewer has returned since, and the
pid of the process serving the click. It is stripped from everything a
client sees, so the served page stays byte-identical to `pages/<id>.html`. A daemon restart reads it
back and does not re-announce; a record written before `returned` existed reads as a shut gate.

The gate opens exactly one way: the reviewer returns, meaning a Watcher *reports* its tab focused.
Nothing else does — not a round ending, not the banner expiring off the screen, not a daemon
restart. It is read lazily off events the daemon already handles; there is no timer on
`awaitDeadline`.

A daemon restart, on either path, is not a return. Killed outright, the daemon leaves its child
orphaned with the banner still up and the record on disk. Stopped gracefully, it SIGTERMs the child
— so the banner goes off the screen — and leaves the record standing with only its `pid` cleared,
since that pid now names a process it has just killed. Both mean the same thing to the successor:
this board has been announced, and nothing more is raised for it until the reviewer comes back.

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

## `GET /api/board/:id/wait?round=N`

A server-side wall-clock ceiling matching `CLAUDE_BOARD_TIMEOUT_MS` (default 40m, ADR.md entry 47): when it fires
the call returns 200 with a packet whose `status` is `timeout`, carrying whatever partial answers
the store holds. A client that disconnects ends the wait outright — nothing is written and the
poll stops.

**Secret-only, unlike every other GET.** `handleWait` writes -- it persists the board on the
timeout branch above and, on every branch, spends what the thread is owed once the response has
actually left: every undelivered comment is marked `delivered: true`, and every submitted round
whose answers this packet carried is recorded in `answersDelivered` -- so this is gated exactly
like a write: the secret header, never the session cookie alone. The only caller is `bin/mcp.mjs`,
which already sends the secret on every request, reads included.

## The pomodoro routes (ADR 8, 20, 67)

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

## The missions routes

The missions ledger (ADR 123): one record per piece of work, across its grill, direct and landing
sessions, at `$CLAUDE_BOARD_HOME/missions/<key>.json`, the key matching `^[A-Za-z0-9_-]{1,80}$`
(a spec's descriptor, such as `FRONT_AGENT`). A key off the pattern is a 400 on every route. Any
agent writes one, and nothing in it is case content: work names, phases, links and closing
summaries.

```js
Mission = {
  key, title, cwd?,
  phase,                     // 'grill' | 'direct' | 'landing'
  state,                     // stored: 'needs-you' | 'working' | 'waiting' | 'queued' | 'released'
  summary?,                  // at most 280 characters
  waitingOn?, next?,         // short phrases, at most 280 characters each
  prs: [ { repo, number, url, state, order? } ],   // state: 'draft'|'open'|'green'|'merged'
  boards: [ { id, url, at } ],                     // linked by a post; the last is the latest
  session: { id?, pid?, name?, login?, startedAt, seenAt, ended? } | null,
  handoff?,                  // a Handoff block, at most 4 KB
  fire?: { at, by },         // by: 'round' | 'card'; written by a Fire round's submit too
  orders: [ { id, kind, text?, at, by: 'card', relayedAt? } ],   // kind: 'stop' | 'comment'
  queue?: { phase, prompt, login?, at },
  history: [ { at, phase, state } ],               // one entry per phase or state change
  createdAt, updatedAt, releasedAt?, retiredAt?,
}
```

**A view is what every read answers**: the stored record plus three fields derived on each read
and never stored. `view` is the column the mission shows in: `released` while stored released;
else `stalled` when its session is gone (a bound `pid` that no longer exists, or a reservation no
`pid` or `id` bound within 5 minutes) or it is stored `working` and `session.seenAt` is over 15
minutes old; else `needs-you` when a linked board's newest round is open and asks a question or was
minted awaited (a lapsed wait still counts; an older round left open does not, ADR 134); else the stored `state`. `live` is whether a session
holds the mission (ADR 129): bound or reserved, not gone, and the mission has not recorded its end
(stored `released`, or phase `grill` with `fire` set); silence frees only a session with no `pid`.
`actions` lists the card's buttons (ADR 125):

```js
actions: [ { kind, board, round, question, choice } ]   // kind: 'fire' | 'merge'
```

one per `single` question carrying an `action`, in a linked board's newest round while it still
wants its answer as `needs-you` reads it: `board` the board id, `round` the round's number, `question` the
question block's id, and `choice` option 0's label, the one a click submits through
`POST /api/board/:id/submit` with `action: 'send'` and `via: 'card'`.

```
GET  /api/missions[?all=1]
       -> { missions: [View], tabs: [Tab], counts: { needsYou, working, waiting, stalled, released, queued },
            live: { working, alive }, now, watcher: { up, lastAt } }
```

Newest change first. A released mission is listed until 24 hours after `releasedAt`, or always with
`all=1`. `tabs` and `watcher` are "The session routes"' below. `counts` are per `view` over the
missions listed, each tab added to its `state`'s count as the Missions view counts its cards; `live` counts every mission holding a
live session, `working` including one that reads stalled. Secret or cookie.

```
GET  /api/mission/:key              -> View; 404 { error } when absent. Secret only
POST /api/mission/:key              { ...fields } -> View
```

The write sets only `title cwd phase state summary waitingOn next prs handoff fire queue
retiredAt`, each typed and capped as above; any other field, a wrong type or a value over its cap
is a 400 that writes nothing. `null` clears an optional field and is a 400 on `title`, `phase`,
`state` or `prs`. A mission that does not exist is created (phase `grill`, state `waiting`, titled
by its key, until the body says otherwise). A phase or state change appends to `history`, and
turning `released` stamps `releasedAt`. `state: 'landed'`, the name before ADR 130, is still
taken and stored as `released`; a record stored `landed` is rewritten as `released` (its
`landedAt` as `releasedAt`) at the daemon's start, and reads as `released` meanwhile.

```
POST /api/mission/:key/launch       { phase, login?, prompt? }
       -> { launch: true }          a session is reserved ({ startedAt, seenAt } now), and the
                                    mission moves to `working` in `phase`
       -> { queued: true }          six missions' sessions working or twelve alive, the others
                                    counted: state `queued`, `queue` holding the launch
       -> 409 { error: 'live', session, silent? }
```

The one check that keeps a mission to one live session. The 409 names the live `session`, and
carries `silent: true` when that session reads stalled by silence while its process lives, which
is how a launcher tells a hang from a busy session. A launch ends the session it replaces,
finished, gone or silent, and that session's `pid` and `id` move to the new session's `ended`; a
queued launch keeps no session, only that `ended`, until it launches.

```
POST /api/mission/:key/session      { pid?, id?, name?, login? } -> { session }
       -> 409 { error: 'live', session }
```

Binds a session, or heartbeats the one bound (`seenAt` now); a hook calls it at every turn's end.
The bound `pid` under a new `id` (after a `/clear`) is a heartbeat that takes the `id`. A
different `pid`, or a different `id` when the bound session has no `pid`, while the bound session
holds the mission is a 409, and so is the `pid` or `id` of the session that ended before this
launch; a different `pid` or `id` once the bound session is gone, or silent with no `pid`, starts a
fresh session. An absent mission is a 404.

```
POST /api/mission/:key/order          { kind: 'stop' | 'comment', text? } -> { order }
POST /api/mission/:key/order/:id/ack  {} -> { order }
```

An order is a card's Stop or comment for the Master Chief to carry to the session (ADR 125); a
comment needs non-empty `text`, at most 4 KB. It is the one mission write the browser's cookie may
make. The ack, secret only, sets `relayedAt` once; a repeat keeps the first. An absent mission or
order is a 404.

Every write publishes `missions` on the daemon-wide stream ("SSE events"). A refusal is
`{ error }` with its status.

## The session routes

The agent sessions running on the machine that no mission launched, reported by a session watcher
outside the daemon and shown on the Missions view as tab cards (ADR 131). The daemon finds no
session itself and reads no agent's folder: a watcher posts what it found. The list is held in
memory only. A session's `name` (its first prompt) and a blocked job's `reason` never reach the
store, a board or mission record, a log line or a notification, and leave with the session or a
daemon restart.

```
POST /api/sessions   { intervalMs, sessions: [Session] } -> { sessions: <count>, watcher }
Session = {
  id,                 // the agent's session id, ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$
  pid, procStart,     // its process and that process's start (UTC ISO-8601), or both null
                      // for a blocked bg job with no live process
  kind,               // 'interactive' | 'bg'
  jobId,              // a bg job's id, or null
  cwd,                // absolute path
  login,              // the agent login it runs under, or null
  name,               // its live name, or null; cut to 200 characters
  status,             // 'busy' | 'idle' | 'blocked'
  reason,             // a blocked job's reason, or null; cut to 300 characters
}
```

A full snapshot, replacing the list whole; secret only, never the cookie. `intervalMs` (1000 to
600000) is how often the watcher posts. At most 100 sessions, ids unique. A malformed snapshot is
a **400** naming the field and the entry's index, never a value, and leaves the list as it was. No
snapshot for two intervals (counted from the last, or from the daemon's start, assuming 30 s, when
none came) reads the watcher down and drops the list.

`GET /api/missions` (above) carries the list as `tabs`, and the watcher as `watcher`:

```js
tabs: [ { id, kind, jobId, cwd, folder, login, name, command,
          state,       // 'needs-you' | 'working' | 'waiting'
          yourTurn,    // true while waiting
          reason,      // a blocked job's, else null
          rounds: [ { board, round, url } ],
          orders: [ { id, kind, text?, at, relayedAt? } ] } ]
watcher: { up, lastAt }  // lastAt: the last snapshot's time, or null since the daemon started
```

A session a mission holds or held is never a tab: its `id` or `pid` is a mission's `session`'s or
`session.ended`'s, its `jobId` is the first 8 characters of such an id, or it posted a board that
belongs to a mission (a launch reserves a session before it knows its pid or id). `folder` is the
cwd's last segment; `command` the name's leading `/word`, else null. `state` is `needs-you` while a
round that wants its answer (open and asking, as a mission's needs-you reads a round, but any
round of the board, not only its newest) sits on a board of no mission whose
`session.id` is the tab's, or whose `session.id` is null or names no listed session, with the tab's
pid and process start (a session resumed in its own process lists under a new id), or while the
session is `blocked`; else `working` while busy, else `waiting`. A process start matches to the
second. `rounds` are those rounds, `url` built off the request's host. Each tab adds one to its
`state`'s entry in `counts` (`needsYou`, `working`, `waiting`), so `/api/waiting`'s `missions`
counts match the Missions view; the launch caps' `live` counts no tab.

```
POST /api/session/:id/order          { kind: 'stop' | 'comment', text? } -> { order }
POST /api/session/:id/order/:oid/ack {} -> { order }
```

A tab card's Stop or comment for the Master Chief to carry to the session, as a mission card's
(ADR 125): the cookie may post it, a comment needs non-empty `text` at most 4 KB, and the ack,
secret only, sets `relayedAt` once. Orders are held with the session and leave with it. A session
not listed, or an order not held, is a 404.

A change to what `GET /api/missions` shows of the list (a snapshot that differs from the last, the
watcher coming up or going down, an order or its ack) publishes `missions` with `key: null` on the
daemon-wide stream; a snapshot repeating the last publishes nothing.

## Marking an already-open tab

Three marks, and no others (ADR 30): the unbadged board mark every page emits in its `<head>`
(`faviconLink`, `src/styles.mjs`); a **counted** mark drawn over it on a `round` push; and
`restFaviconHref`, on the index tab only, while the pomodoro is in an unpaused break. A pending
count outranks the rest mark outright. `document.title` is left alone.

The favicon mark is the only notice the page itself raises; a round nobody is watching for is the
daemon's own native banner instead ("The stranded banner", above), which is what a closed or
buried tab now relies on. Every part of the mark degrades silently: a failure anywhere leaves the
round pushed and the page working, just unmarked, and all of it is inert in readonly mode. Shim
side: printing the board URL in chat as the fallback that cannot fail.

## SSE events

`GET /api/board/:id/events`: a `text/event-stream` subscription, one per connected client, for
round pushes and submits on `:id`. 404s up front if the board doesn't exist; otherwise the response
never ends on its own. Heartbeat comment lines (`: heartbeat\n\n`) keep it alive through idle
timers and proxies — invisible to `EventSource`'s message events, so they never surface as a stray
event. `CLAUDE_BOARD_SSE_HEARTBEAT_MS` overrides the cadence (default 15000), for checks only.

Four named events. The middle two carry the page's own copy of the board, the same bytes a served
page inlines as `#board-data` (ADR 122), so a client can diff against its own last-known copy, plus
enough to apply the push without a reload. That copy is the stored board less `cwd`, the daemon-only
fields, and every html block's `html`, wherever the block sits; the block keeps its `sha`, which is
how a diff sees a stage change. A page carries each stage once, in its frame's `srcdoc`:

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

Every stage frame names its content by its block's sha, `<iframe class="html-stage" … data-sha="…">`.
A push sends a stage every tab showing the board already holds **held**: the same frame with no
`srcdoc`, marked `data-held`. An amend holds, in each block it re-posts that already sat in the open
round, each stage that block held before it (keyed on the sha, since an amend re-mints the ids of the
blocks nested in a block it re-posts); a block it adds holds none, whatever stage it carries, and a
new round holds none. The client keeps its live frame wherever a push's markup names the same
`data-sha` in the same place, making the markup over around it rather than replacing it, so the mock
keeps its state (a paused video its second); a frame that names a new sha goes in as it came. A held
frame no live frame can stand for is filled from `GET /b/:boardId?stages=<sha>,...`, naming the shas
of the frames left held, which serves only those stages whole; the client puts each into the held
frames that name its sha. So a push and a later full reload carry the same `board` bytes and the same
markup, but for a held frame, empty in the push.

A push holds stages only for a subscription that declares it can fill a held frame, by opening the
stream as `GET /api/board/:id/events?stages=held`, as today's page script does. A subscription that
declares nothing is a tab still running a page script from before held frames: its pushes carry every
stage whole, and their `board` keeps each html block's `html`, the copy that script holds and diffs
against (its diff sees a stage change through the html). Its catch-up read, a script's fetch of the
plain `GET /b/:boardId` (`Sec-Fetch-Dest: empty`, never sent by today's script), inlines that same
copy, so it replaces no stage that did not change. A navigation to the plain route gets the page as
served.

`submitted` fires on every submit, to every connected client including the one that just
submitted, so a second tab sees the round go sent — and read-only, if that page is the one it is
showing — without reloading. Its `html` is the re-rendered `<section class="round">` in sent/history
form, every stage in it held, since a submit changes no block; without it a client that did not
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
touches no DOM. The re-read is `GET /b/:boardId?stages=held`, the page with every stage held: it
inlines both the payload (`#board-data`, `resolveComment` already run over it, the same bytes as the
plain page) and the server-rendered markup for every round, and leaves out the stages the tab
already holds, so a page loads once rather than twice. A dedicated JSON route would be leaner and
can be added later without changing this rule.

### The daemon-wide stream

`GET /api/events`: the same `text/event-stream` shape as `/api/board/:id/events` above — the
`: connected` comment, the heartbeat cadence, the close/error cleanup — but not scoped to a board
and never 404s, because there is no id to fail to find. It exists for a subscriber with no single
board to open one under: `bin/menubar.m`, which has no `:id` at all, and the index page
(ADR 87), which lists every board rather than holding one. Every subscriber gets every event —
there is nothing to key subscribers by, unlike the per-board stream. No `watcher` event either:
nothing published here is per-connection.

```js
event: pomodoro   data: { settings, cycle, cycleDate, timer, now }   // same shape as GET /api/pomodoro
event: waiting    data: { total, now }                               // same total as GET /api/waiting
event: missions   data: { key, now }                                 // which mission changed; key null: the tabs
```

`pomodoro` fires after every write under `/api/pomodoro/*` (ensure, pause, resume, reset, forward,
restart, settings) and, independently of any request, the instant a running interval crosses a
phase boundary on its own — the daemon's internal clock reconciling with nobody polling. `waiting`
fires whenever a round could plausibly have entered or left the waiting set: a round posted or
amended into an awaited state, a submit, an abandon, or a wait's wall clock lapsing. It carries
only the count, not the rows — a client that wants the rows still asks `GET /api/waiting` for them.

`missions` names one mission whose view may have moved, and nothing else: a subscriber re-reads
`GET /api/missions` for it. It fires on every write under `/api/mission/:key`, on every `waiting`
caused by a board linked to a mission (its newest round decides whether it reads needs-you), and from the
daemon's missions watch (ADR 128), which reads every mission each 30 seconds and publishes a
derived change no write made: a session whose process died, or one gone silent past 15 minutes.
A read between the watch's ticks can therefore see a stall before the event says so. With `key:
null` it names the tab cards instead ("The session routes"): a changed snapshot, the watcher up or
down, a tab's order, or a round on a board a session posted.

## Stage postMessage channel

The page's second wire contract, between the board page and an `html` block's sandboxed stage.
`src/render.mjs`'s `stageAgentScript` is the stage half -- joined, on a stage that carries a
diagram, by `stageMermaidPrelude`'s engine facade, which speaks the same channel for the
`mermaid` type alone; `src/ui.mjs`'s message listener is the
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
| `click` | `{ ref, tag, text, time? }` | step path plus **raw** tag/text, never a composed hint. On a `<video>`, `text` is its identity (`aria-label`, else `title`, else empty) and `time` the whole second it shows |
| `link` | `{ url }`, `{ top }` or `{ top, scrolled: true }` | `{ url }`: "the reviewer clicked this `http`/`https` address inside me", which the board opens in a new tab. `{ top }`, no `url`: "the reviewer clicked an in-page anchor I have nothing of my own to scroll to; its target sits this far down my viewport", which the board scrolls itself to. `{ top, scrolled: true }`: "I scrolled to an in-page anchor myself; its target now sits this far down my viewport", which the board scrolls to only if that spot is hidden: under its header, or within the same clearance of the window's bottom edge or past it (ADR 113 and 119, and "Links inside a stage" below) |
| `positions` | `{ requestId, positions }` | response to `locate`: per requested ref, `{left, top}` in the frame's viewport coordinates (the element's own client rect), or `null` if the ref no longer resolves. Numbers and null only |
| `height` | `{ height }` | the height this whole document needs to show with no vertical scrollbar (see below) |
| `scroll` | `{ top }` | "I am at this offset". Deduplicated on the last reported value |
| `mermaid` | `{ requestId, sources, config }` | "draw these diagrams for me". Sent only by the engine facade a diagram-bearing stage is given, and **repeated under the same `requestId` until answered** (see below) |

`ref` is a `buildSteps`/`stepsToPath` index chain from `document.body`.

`click` carries raw tag/text rather than a hint because composing *identity in context*
(`composeHint`, `src/anchor.mjs`) needs the outer document's knowledge of whether this stage sits
inside a compare side, which the stage cannot see. The parent calls `buildHint` on what it
receives, through the same function every other content kind's click already uses. This is also
why `composeHint` needs no third copy embedded here: only
`buildSteps`/`stepsToPath`/`pathToSteps`/`resolveSteps`, and `videoIdentity`/`videoSecond` for a
video's click, are, bound via `.toString()` from `src/anchor.mjs`, never hand-copied.

`positions` only ever positions a pin the parent already decided to draw from its own
server-verdict-derived comment list (`commentsWithPending`), never to decide *whether* a pin
exists.

`height` is measured by the stage, since the parent cannot reach its document: the largest of
the root element's box (the body plus any margin collapsed through it), the root's
`scrollHeight` once the document overflows the frame, and the body's own `scrollHeight`, plus
the viewport's horizontal scrollbar when there is one, rounded up. The first report waits two
animation frames for a real layout (a sandboxed `srcdoc` frame reads 0 before one), and a
`ResizeObserver` on the body and the root reports every change after it. A new value is posted
twice: at once, and again from a re-measure two frames later, so a height that holds arrives as
two matching reports.

It is stage-authored like every other field, so the parent (`handleStageHeight` and
`applyStageHeight`, `src/ui.mjs`) drops a non-finite or non-positive value and caps the rest at
`STAGE_TRAVEL_CAP` (30,000) before applying its own rules (ADR 119). They apply to every stage
outside a page board: top level, in a compare side, in a question's context and in a variant
option. A page board's stage keeps its full-window box and no report is applied to it (ADR 33).

- **Placeholder.** Until its first report a stage holds 320px (`STAGE_HEIGHT_FLOOR`, the
  `.html-stage` starting height). A board opened in a background tab gets no report until the
  tab is shown.
- **Fit.** The box is the report plus the frame's 2px border, never under 120px
  (`STAGE_HEIGHT_MIN`). A box under 320 is believed only on two matching reports in a row: a
  single sliver, measured before a mock that lays out from the viewport has built itself, holds
  the box where it stood.
- **Fold.** Past 600px (`STAGE_HEIGHT_CAP`) the box stays at 600, the mock scrolls inside its
  frame, and the block carries `.stage-folded`, which shows the Show full height bar. It unfolds
  only once the content falls 32px (`STAGE_FOLD_SLACK`) under the cap, so a mock breathing
  around 600 does not flicker the bar. A variant option's stage clips at 600 instead and never
  shows the bar: a click on its card picks it (ADR 22).
- **Open.** Show full height sets `.stage-opened` and a one-time snapshot of the report, capped
  at 30,000, which later reports never move: a mock sized in viewport units grows with its own
  frame and would otherwise never stop. Show less folds it back to 600 and the latest report
  applies again. A stage the server renders opened (one holding a stored comment, so its pins
  are never under a fold) takes its first report past the cap as that snapshot; a first report
  under the cap drops the mark and the stage fits.
- **Pace.** At most one applied height per animation frame, however many reports arrive.
  Growth applies at once; a shrink waits until the smaller box has held for 300ms
  (`STAGE_SETTLE_MS`), and any growth in between cancels it.

What the cap hides on a variant option is not lost: the same reported height is what tells the
parent the stage has somewhere to scroll, which is what `scrollBy` below forwards a wheel notch
for.

No stage reports a width: a frame is as wide as the box it sits in. The board's shell runs as
wide as the window, up to 2560px (`.board-shell`, `src/styles.mjs`), and from a 1440px window
every card under its header sits in one 1100px column centred on the window, the window either
side plain page (ADR 138); below 1440px every card takes the shell's width. A top-level stage,
diagram or compare spans its card less the card's padding, and so does a stage in a question's
context, since a question carrying one lays out in one column (ADR 26). From 1440px a question's
options take the card's left half, never under 523px, with its note and Defer row under them at
that width, and a diagram or compare in its context panel gets the right half. A compare side gets
half; an `html` variant option takes a whole row, other variant kinds share one. Below a 1440px
window prose does not widen with the card: a line set straight in a block keeps the 1022px the old
1120px column gave it (a line in the options, the context panel or a compare side still widens
with its box). From 1440px prose carries no cap and runs its card's width, long open text flowing
into two columns. An option's `preview` image or code is not prose: its card keeps the old
column's width, so a preview is never drawn narrower than it was.
A page board's stage fills the window, as before (ADR 33).

`scroll` exists because ADR 40's page-board header condenses on the reader's scroll, but on a page
board the document itself never scrolls — the artifact scrolls inside the opaque-origin frame — so
the parent cannot observe it short of being told.

### Parent → stage

| type | payload | meaning |
| --- | --- | --- |
| `mode` | `{ commentMode, sentRefs?, sentTimes?, theme? }` | comment mode on/off. The stage keeps its own flag, read by the same `if (!commentMode) return;` guards the old in-parent listeners used. `sentRefs` lists the block's untimed `dom` refs already sent; `sentTimes` lists each video second already sent as `{ ref, time }`. `theme` is the board's theme resolved to `light` or `dark` (System included); see below |
| `locate` | `{ requestId, refs }` | asks for the current `{left, top}` of every ref |
| `band` | `{ top, bottom }` | the board's own chrome band, right now (ADR 59) |
| `scroll` | `{ top }` | "put yourself at this offset" |
| `scrollBy` | `{ delta }` | "move yourself this many pixels" — one forwarded wheel notch |
| `diagrams` | `{ requestId, svgs }` | response to `mermaid`: one entry per requested source, in the same order — the rendered SVG as a string, or `null` for one the board could not draw |

`scroll` is the one bidirectional type on this channel. Inbound it is sent only as a reset,
`top: 0`, by the board's back-to-top control, since the parent cannot scroll a cross-origin
document itself. Both directions aim at whichever element most recently identified itself as the
scroller, never at the document by assumption.

`scrollBy` exists because a variant option's stage is the one surface where the reviewer's own
wheel can never reach the mock: the frame is `pointer-events: none` inside a `.choice-variant`
card, so the gesture lands on the card in the parent document, which cannot scroll an
opaque-origin document either. The parent forwards the notch instead — sent only while the stage
reported a `height` past `STAGE_HEIGHT_CAP` (i.e. the cap is genuinely hiding something) and only
until its own last reported `top` reaches that end, so the notch chains back to the page at the
mock's top and bottom rather than trapping the reader in the card. Relative, not absolute: the
parent knows how far the reviewer turned, never where the stage currently is. It is a pixel
delta whichever unit the wheel reported, and it applies `behavior: 'auto'` — one notch is
already the reader's granularity.

Forwarding a notch is not a hole in the rule above it: no pointer event reaches the stage, so
this adds no path from a stage to its own selection, and the Lens, opened by the stage's
Pull-out (ADR 120), remains the only place a variant's stage becomes genuinely live.

The hover stylesheet is injected lazily, the first time `commentMode` turns true. A read-only
archive never sends `commentMode: true` (`setCommentMode` refuses to enable comment mode when
`readonly`), so an archived stage's document never gains one.

**The theme a stage is told.** `mode` goes to a stage when it announces `ready` and again on
every theme change, an OS flip under System included, and `theme` is all the stage learns of the
board's theme: it sets `data-theme` on its own root and nothing else, and any value but `light`
or `dark` leaves the attribute as it was. A template that conditions its colors on `data-theme`
follows the board that way, in a read-only archive too.

The stage's `color-scheme` is not the board's to set. The artboard behind a stage (`--stage-bg`)
is a light neutral in both palettes, `#c3c6cd` dark and `#e6e8ee` light, and both frames
(`.html-stage`, `.stage-lens-frame`) declare `color-scheme: light`, so a mock that sets no color
draws the browser's light-scheme defaults on it whatever the board's theme. Measured in Chrome on
the dark artboard: black text 12.28:1, the `#0000ee` link blue 5.50:1, a text input 21:1 on its
own white field, a button 18.26:1 on its own face. The frame's declaration and the document's
scheme have to agree for the artboard to show at all: where they differ the browser paints the
frame an opaque canvas of the document's scheme. So:

- A frame left on the dark page's scheme with its document stamped dark as well draws white
  default ink on the light artboard (1.71:1), and with its document left light draws an opaque
  white canvas in place of the artboard.
- A mock that declares `color-scheme: dark` on its own root, for a dark palette it paints under
  `[data-theme="dark"]`, gets dark form controls and scrollbars, and the browser's dark canvas
  wherever it paints no background.
- `prefers-color-scheme` inside a stage follows the frame's declaration, so it reads light
  whatever the board's theme or the OS.

The Lens's copy is told the theme as well, parent to frame only. It is not a wired stage: its
`ready` is never answered and no message from it is acted on. Once its document has loaded, and
again on every theme change while the Lens is open, the board posts it one `mode` carrying
`commentMode: false`, an empty `sentRefs` and the resolved `theme`, whatever the board's own
comment mode. So the copy carries the same `data-theme` as the stage in its block, a template
draws the same side of its palette in both, and the Lens stays view-only.

`band` exists because the parent's header, dock and comment rail float **over** the frame rather
than pushing it down, so an artifact that pads nothing loses its own opening under them. No fixed
number is baked in on either side — the header's real height moves with the title's wrap and the
viewport width — so the parent measures its live chrome (`reportStageBand`) and the stage tops its
own `body` padding up to at least that much, rather than overwriting padding the artifact already
had. Parent to stage only: reserving space for the board's chrome is the board's decision, never a
negotiation.

`locate` and `band` are both sent once a stage announces `ready`, and again whenever the parent's
own refresh runs (resize, a comment queued, a submit landing, a round flip). `locate` alone
additionally rides each `scroll` report from a stage that has pins to follow -- `band` is a fact
about the board's own chrome, which a stage's scroll changes nothing about -- and every applied
`height` and fold toggle, two animation frames after the new box is written, at most one ask per
frame: a mock lays out against its own frame, so a new box moves a centred or bottom-docked
element with no scroll or resize to re-ask on.

### Links inside a stage

A stage is a `srcdoc` frame, so every relative href in it, an in-page `#anchor` included,
resolves against the **board page's own address**. A click's default action is therefore a
navigation of the frame to `/b/<id>#s1`, which the page CSP (`default-src 'none'`, no
`frame-src`, inherited through `srcdoc`) refuses: Chrome paints its blocked page over the
artifact. So the stage script owns the click and cancels that default for every `<a href>`,
whichever mode is on, and decides what happens instead (ADR 113):

- **Comment mode on**: the click mints a comment anchor exactly as any other click does, and
  nothing else: it neither scrolls nor opens.
- **`href="#id"`, a frame that can scroll to it**: the stage scrolls the boxes inside the frame
  that can move the target (`frameScrollBoxes`: each ancestor of the target that is a scroll
  box holding more than it shows, innermost first, then the frame's own viewport when the
  document overflows it), each with its own `scrollTo`, so an artifact whose scrolling element
  is an inner pane (an app-shell layout, where the document itself never scrolls) works too.
  Each box puts the target the last `band` the parent reported below its visible top, so the
  target lands **below** the board's floating header rather than under it. Never
  `scrollIntoView`: Chrome carries a frame's scroll-into-view on into the board, through the
  opaque-origin boundary, and the board would scroll as well, leaving the target under its
  header. Then the stage posts `link` with `top`, where the target now sits in its own
  viewport, and `scrolled: true`. Off a page board no `band` is sent, so that is the frame's own
  top, and the reader may have scrolled the frame's top above the window or under the sticky
  header, which the stage cannot see. Nor can it see the window's bottom edge: a frame that runs
  out of scroll before the target reaches its top (a target near the document's end) leaves the
  target lower in the frame, which may be below the window. The board can see both. It leaves
  its window still when the target landed in the visible band, from `--head-clear` under the
  window's top to the same clearance above its bottom (room for the target's first lines above
  the sticky send bar), and otherwise moves once, bringing the target to `--head-clear` under
  the top. A fragment naming nothing scrolls nothing and posts nothing; the click is cancelled
  either way.
- **`href="#id"`, a frame with nothing to scroll**: a stage that fits its content, or one
  opened by Show full height, shows its whole document, so only the board scrolling can bring
  the target into view (ADR 119). The stage decides which case it is in from its own geometry
  (`frameScrollBoxes` finds no box), and here posts `link` with `top`, the target's top in its
  own viewport, and does not scroll itself, so no second scroll races the board's.
- **`http:`/`https:`**: posted as `link` above, read off the raw `href` attribute rather than
  the resolved `.href` property. Resolved, `#s1` reads as an ordinary http address (the base
  URL is the board's), and the in-page case would post the board's own URL.
- **Anything else** (`javascript:`, `file:`, `data:`, a relative path, a protocol-relative
  `//host/x`) is dropped in silence. Nothing is opened and nothing is navigated.

The parent's half is `handleStageLink` (`src/ui.mjs`), which **opens the address at once**, in a
new tab. It is a trust boundary like every other handler here:

- `url` must be a string of at most 4096 characters and must **parse** (`new URL`) to an
  `http:`/`https:` address. The parsed `href` is what opens. Anything else opens nothing and
  changes nothing on the page at all.
- `window.open(href, '_blank', 'noopener')`: a new tab, and no `window.opener` back into a board
  page holding every answer on it. Such an open hands back `null` by definition, and nothing
  reads it.
- No address is shown and nothing is confirmed first: the reviewer's click inside the frame is
  the gesture, and Chrome's own hover bubble already names the target. That click also gives the
  ancestor document its user activation, which is what keeps the open out of the popup blocker.
  The callback token is a fixed literal, so a stage's own script can post a `link` with no
  reviewer gesture behind it; with no activation to spend, that one meets the blocker.
  `SECURITY.md`, "The one outbound path a stage has", carries the risk this accepts.

A `link` with no `url` goes to `handleStageAnchor` instead, which scrolls the board and opens
nothing. `top` must be a finite number, and is clamped to the frame's own box, so a stage can
only bring a point inside itself to the top of the window, never send the board elsewhere.
`scrolled` must be absent or exactly `true`; anything else moves nothing. The board scrolls
smoothly until that point sits `--head-clear` (88px by default) under the window's top, the
clearance every other scroll-to on the page uses, its offset rounded down so the point never
lands a fraction under the header. With `scrolled: true` it does so only when the point sits
outside the visible band: above `--head-clear`, or lower than `--head-clear` above the window's
bottom edge (`window.innerHeight - --head-clear`, which covers a point past that edge too).
Inside the band the board stays still, so the frame's move and the board's add up to one and
neither box scrolls twice. A page board's stage is never acted on: it fills the window, and the
page under it does not scroll.

Stage to parent only: what a board does with an address is the board's decision, and a stage is
never told the outcome.

### `mermaid`/`diagrams`: the board draws a stage's diagrams

A stage runs at an opaque origin, and Chrome refuses a `file:` subresource to such a
context at the local-resource level, whatever the CSP says. So a diagram-bearing stage
gets two things prepended to its `srcdoc` (`src/render.mjs`): the engine's bare sibling
filename, which loads for real on the SERVED surface before any of the stage's own
scripts run, and an inline prelude that shape-checks `window.mermaid` and — when the tag
did not deliver, i.e. every `file://` archive — installs a facade with the same API
surface (`initialize`, `run`, `init`, `render`, `startOnLoad`/`contentLoaded`). The facade
renders by sending `mermaid` here and swapping the returned SVG in **only on success**: a
figure whose render failed keeps its own raw source, never a blank box, and releases its
`data-processed` claim so a later pass may try again. An artifact's own loader
(`if (!window.mermaid) …`) therefore short-circuits on either surface and its CDN
fallback never starts.

`mermaid` is the one type on this channel that is **retried rather than fired once**, and it
has to be. The parent's listener belongs to its deferred `ui-<hash>.js`, which cannot run
until the whole board page has parsed; a stage's own scripts run as soon as its frame exists.
Nothing orders those two, so a single send is lost outright whenever the stage wins, and the
figure stays on raw source for the rest of the page's life — measured as an intermittent
archive failure in real Chrome, and reproducible on demand by removing the resend
(`test/browser-check-mermaid-stage.mjs`). The facade repeats every request on a 150ms interval
for at most twelve seconds; giving up releases each figure's `data-processed` claim so it
reads as its own raw source. A resend carries the **same `requestId`**, and the parent **drops
a `requestId` already in flight for that frame** — never queueing it twice (which would draw
the same figure twice) and never answering it twice (a refusal racing the real reply would
latch failure onto a figure about to be drawn). The id is released once its answer is posted.

The same race exists for `ready` above, unfixed: a stage that announces itself before the
parent listens is never wired for comment mode, pins or the chrome band. It predates stage
mermaid and is not closed here.

The parent side is a trust boundary, and every rule below is load-bearing:

- `requestId` is a non-empty string of at most 64 characters; `sources` is an array of 1
  to 32 strings of at most 50000 characters each. A batch outside those bounds is
  ignored in silence; a single source outside them is answered `null` in place, so the
  reply's indices always line up with the request's.
- `config` is forwarded through an **allowlist** (`theme` from mermaid's own theme names,
  `themeVariables` as short scalars under plain identifiers — `MERMAID_STAGE_CONFIG_KEYS`,
  exactly those two) and nothing else. A top-level `fontFamily`/`fontSize` is dropped; a
  template that wants them sets them inside `themeVariables`, where mermaid reads them
  anyway. `securityLevel` is not on the list and must never be: it is what keeps
  mermaid's own sanitizer on. `startOnLoad` is fixed by the parent.
- The engine is re-initialized for every batch, and `initialize()` resets mermaid's site
  config from its own defaults, so a stage's palette cannot bleed into the next
  board-level render.
- The reply goes to the frame re-derived from `event.source`, never to anything the
  message claims about itself, and it always goes: an unanswered stage would leave its
  figures claimed and waiting forever.

`GET /b/mermaid-<hash>.js` is the one credential-less read the daemon allows, because the
stage that fetches it structurally holds no credential; see `src/server.mjs`'s
`isOpenRoute` for the argument and `SECURITY.md` for the isolation model it sits inside.

### There is no `select` message, deliberately

No message on this channel selects an option: a `select`-shaped message from a live,
correctly-addressed stage is inert because no handler is left to act on it, and an `html` option's
frame renders `pointer-events: none` inside its `.choice-variant` card so a real click over the
visible mock lands on the card in the parent document instead. Why the message was deleted rather
than guarded: `ADR.md` entry 78.

### Origin validation

An opaque-origin `srcdoc` frame has no real origin, so the usual same-origin comparison is
meaningless here. Each side validates something else:

- **Parent reading a stage message** checks `event.origin === 'null'` — the HTML standard
  serializes an opaque origin in a `postMessage` event as that literal four-character string,
  always, whatever URL or port the parent page is served from. Any message carrying a real origin
  (an extension, devtools, a same-origin script in the same tab) is rejected before any shape check
  runs. Necessary but not sufficient: it does not say *which* stage.
- **Parent identity check**: `event.source` must equal the `contentWindow` of a currently-mounted
  `.html-stage` frame, re-derived by walking the live DOM at receive time rather than trusting an
  id the message claims. The browser stamps `event.source` from the calling script's actual global
  object, so no page script can forge it, and it is never read off the attacker-controlled
  `event.data`.
- **Stage reading a parent message** checks `event.source === window.parent`. The stage cannot know
  the parent's real origin in advance (any port, or `file://`), and no script in any window can
  make `event.source` equal a different window's `window.parent`, so identity alone is sufficient
  here.

### Shape validation

The stage document is attacker-controlled, so the parent assumes the mock's own script sends it
hostile messages on the same channel the agent uses.

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

Three tools on the stdio shim: `ask`, which posts a board and blocks on it, `read`, which reads
one back (ADR 115), and `mission`, the missions ledger, each with its own subsection below. `ask` arguments mirror the board document:
`{ title, blocks, wait?, fresh? }`, where question blocks carry their questions by value and
content blocks carry a `source` ref. It posts a board and opens the tab on the thread's first
board.

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

`ask` fails loudly and writes nothing, on three triggers: an unreachable daemon (returns the revive
command), a non-interactive session, or a session on which nothing can open a tab at all — an SSH
session on a machine with no display passes the first two checks and would otherwise post a board
nobody can see and block for the full wall-clock cap. Both session checks are below, and both are
`ask`'s alone: `read` skips them.

A daemon **refusal** (any 4xx, which is what a post carrying a reference that does not resolve
comes back as) is loud in a different key: the tool result carries the daemon's own message
verbatim — every failed reference's line of it — plus "the daemon is running, fix what was posted
and call `ask` again", and deliberately no revive command, since kickstarting a healthy daemon
fixes nothing and costs the reviewer the session.

The shim tracks one thread per CONVERSATION, not one per process (ADR.md entry 69): the first
`ask` call starts a new thread and opens its tab; every later `ask` call in the same conversation
pushes a round into the same live board (`POST /api/board` with `boardId` set) and opens no tab of
its own. A round landing with nobody watching is the daemon's stranded banner to raise, not the
shim's tab to force open. The first call opens no tab either when the response says `suppressed`
(ADR.md entry 91): some board somewhere already has a Watcher, and the banner announces this one
rather than a fresh tab stealing focus from the reviewer sitting on that one. `CLAUDE_BOARD_NO_OPEN`
and the "nothing here can open a tab" refusal are unchanged and sit outside this: they are about
what this machine *can* do, and suppression is about what it *should*. `bin/authorize.mjs` still opens a tab, being the standalone recovery
command a reviewer runs deliberately.

**`fresh`** is what separates one conversation from the next, because nothing else can. Claude Code
does not restart stdio MCP servers on `/clear`, so this process — and the board id it holds in
memory — outlives the conversation that minted it, and no session id reaches the shim by
environment variable, by `initialize` handshake or otherwise. The agent's own context is the only
place the boundary is visible at all: after a `/clear` it is empty, so "have I posted a board in
this conversation?" is a question the agent can always answer. `fresh: true` means "no", and the
shim clears `session.boardId` and `session.thread` on it, so this call mints a new thread and opens
its tab; the board it walks away from has its open rounds closed through
`POST /api/board/:id/abandon` above. The clear happens first and unconditionally — a daemon that is
down cannot wedge a new conversation onto the old one's board — while the abandon waits for this
call's post to actually land, because a refused post (ADR 112) must close nothing: the previous
conversation's open round is still the reviewer's until something replaces it, and a re-post with
the reference fixed is what closes it. The abandon itself is best-effort, its failure a stderr
line. Every result text of a `fresh` call names the board it walked away from, in one fixed
sentence: `Abandoned board: <url> (the previous conversation's board, closed by this fresh ask).
Call read with that URL to collect any answer left on it.` That id does not survive the boundary
any other way, and a reviewer answering after the abandon is exactly the case ADR 114 stopped
throwing away, so the URL is what makes the answer reachable at all. `fresh` on a conversation
that has posted no board is a
no-op: one board, one thread, one tab. Correctness rests on the agent passing it; nothing can
detect a missed one, which is why the manual has the agent state the board URL in chat each round
(a `/compact` is built from chat, not from tool results).

### The `read` tool

`{ board }` and nothing else: the board page URL an `ask` result ends with
(`http://127.0.0.1:<port>/b/<id>`, any port, since a URL from an earlier session still names an id
this daemon can look up) or a bare board id. Anything else is refused in the shim, before a request
goes out, because the value ends up in a URL path segment. It calls `GET /api/board/:id/read` and
hands the document back on the same three channels a packet rides:

```js
{ board, thread, title, url,
  rounds:   [ { n, title, status, awaited, deadline } ],
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, lost? } ] }
```

The text channel carries a line per round and a line per stored entry, each naming the round it
belongs to, because an MCP client may keep only `content`: telling round 4's late answer from
round 1's settled one has to be possible without opening the board. `awaited` is the product's
"this round has an open wait", not the raw mint-time flag; `deadline` is left where it was, so a
reader can see when the wait died.

It exists because a stored answer had exactly one way out (the next packet a wait on the same
thread returned) and three ways to be stranded: a lapsed round in a conversation that asked nothing
further, an abandoned board no thread ever waits on again, and a new conversation holding nothing
but a URL. It is a **pure read**, and that is the whole decision (ADR 115): no delivered mark, no
ledger write, no session state touched, so reading a previous conversation's board never makes it
this conversation's board, no credential can burn an answer by reading it, and a board written
before ADR 107 reads exactly like any other rather than being adopted into a rule it was never part
of. The accepted cost is the redelivery named under "Packet" above.

Neither session check below applies to it. `ask` refuses a headless session and a machine that
cannot open a tab because it would otherwise put a board in front of nobody; `read` puts nothing in
front of anybody and writes nothing, so an unattended run collecting an answer left overnight is a
legitimate caller rather than the case those refusals exist for. A missing or rejected local secret
refuses it exactly as it refuses `ask`, in the same words, naming the tool that was refused: "read
refused: ... The claude-board daemon only serves a tool call from a caller holding the local secret
at ~/.config/claude-board/secret".

### The `mission` tool

```js
{ action: 'list' | 'read' | 'write' | 'relay' | 'ack',
  key?, all?, fields?, board?, round?, answers?, words?, order? }
```

Any agent (Claude, Codex, OpenCode) writes its own work's status here, never case content
(ADR 123). One daemon call per action, each the route of "The missions routes" or the relay
above:

```
list    { all? }                              GET  /api/missions, `?all=1` when all is true
read    { key }                               GET  /api/mission/:key
write   { key, fields }                       POST /api/mission/:key, with fields as the body
relay   { board, round, answers?, words }     POST /api/board/:id/relay; board is a board URL
                                              or a bare id, as `read` takes it
ack     { key, order }                        POST /api/mission/:key/order/:id/ack
```

`key` matches the store's key pattern, `all` is a boolean, `fields` an object and `order` an
order id; an argument off its shape, or an unknown `action`, is refused by the shim before any
call, naming the argument. The daemon's answer comes back as JSON on the text channel and as
`structuredContent`. A refusal is the tool's error (`isError: true`) with no packet fields: the
daemon's own, as `mission <action> refused by the daemon (HTTP <status>): <message>`, and a daemon
that cannot be reached, or a missing or rejected secret, in the words `ask` and `read` use for
the same, naming `mission`. Like `read`, it skips both session checks: a status write shows a
human nothing, and the sessions that write most are the ones nobody watches.

### MCP shim environment

Additive to `CLAUDE_BOARD_HOME` / `CLAUDE_BOARD_PORT` above.

```
CLAUDE_BOARD_TIMEOUT_MS       wall-clock cap on the blocking wait, default 40m (2_400_000,
                               ADR.md entry 47) -- shared by the daemon's own /wait cap
CLAUDE_BOARD_PROGRESS_MS      notifications/progress cadence, default 20_000 (20s)
CLAUDE_BOARD_POST_TIMEOUT_MS  timeout on POST /api/board only, default 10_000; never applied
                               to the /wait call, which must survive the full wall-clock cap
CLAUDE_BOARD_CREATE_TIMEOUT_MS
                               how long the THREAD-CREATING post may run, as opposed to how
                               long the call waits for it (above), default 3x that. The first
                               post carries no board id, so a lost response leaves a board the
                               shim cannot name and the retry mints a second one; letting the
                               post outlive the call that made it is what lets the retry join
                               it instead
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
CLAUDE_BOARD_CLIENT=background
                               a session the Master Chief started with nobody at it: it passes
                               the interactivity check as any declared client does, and `ask`
                               opens no tab; the board's own notification still fires.
                               CLAUDE_BOARD_HEADLESS=1 still wins over it
CLAUDE_MISSION                the mission key this session works for: every board post carries
                               `mission: <key>`, so the daemon links the board to it. A value
                               that is not a mission key is ignored, never a failed post
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
refusal regardless, which is the hook an unattended runner sets. `ask` is the whole scope of this
section and of the tab check below it: `read` and `mission` show a human nothing, so they run in a
session both of them refuse (see "The `read` tool" and "The `mission` tool" above).

**Codex and OpenCode export no entrypoint an MCP server can read**, so for them the registration
itself is the declaration (ADR.md entry 116): `install.sh` step 5 bakes `CLAUDE_BOARD_CLIENT=codex`
into Codex's `env` table and `CLAUDE_BOARD_CLIENT=opencode` into OpenCode's `environment`, and a
non-empty `CLAUDE_BOARD_CLIENT` passes the allowlist above. The value names the client for the
reader; the guard checks only that it is set. A hand-written registration for some other client
sets it the same way, and in doing so takes on the promise Claude Code's entrypoint makes for it:
a human is at the keyboard of every session that loads this registration. Codex hands a stdio
server an allowlist of the parent environment plus that `env` table and nothing else, so the
declaration has no other way in there, and neither does `CLAUDE_BOARD_HEADLESS` from a shell.

Known residual gap, deliberately not papered over: `/nightly` and `/loop` run *inside* an
interactive session, so the entrypoint still reads `cli` and no env check can see them. That is a
rule those commands must carry, not a mechanism the shim can enforce. `codex exec` and
`opencode run` are the same gap one step out: they load the same registration as the interactive
TUI, so the declaration passes there too. The rule an unattended run carries is to leave the
board out for that run: `codex exec -c mcp_servers.claude-board.enabled=false`, and for OpenCode
either `CLAUDE_BOARD_HEADLESS=1 opencode run` (OpenCode does pass its environment through) or
`OPENCODE_CONFIG_CONTENT='{"mcp":{"claude-board":{"enabled":false}}}'`.

**A background session declares itself the same way** (ADR 127): `CLAUDE_BOARD_CLIENT=background`
is a non-empty value, so it passes the allowlist, and the shim reads that one value as nobody at
the terminal: `ask` posts and waits as ever and opens no tab, and the round reaches the PM through
its Banner and the Missions view. The Master Chief's launcher sets it on the sessions it starts;
`CLAUDE_BOARD_HEADLESS=1` still refuses over it, and a `claude -p` run without it is still refused
by its entrypoint. Setting it makes 116's promise for the session, so an unattended run never
carries it.

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
