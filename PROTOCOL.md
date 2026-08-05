# PROTOCOL — shared contract for `claude-board`

This file is the integration contract every ticket builds against. It is derived from
`DESIGN.md` (Decisions → "One block document, two modes") and fixes the details the
spec leaves elliptical, so that independently-built chunks compose.

**Rules for changing this file:** if a ticket needs a shape that is not here, add it here
in the same commit that uses it, additively. Do not repurpose or rename an existing field.

## Layout

```
bin/daemon.mjs      the HTTP server's entry point
bin/mcp.mjs         stdio MCP shim, one per Claude session
bin/launcher.c      launchd entry point: compiled by install.sh into a signed app bundle
                     that forks bin/daemon.mjs, so macOS TCC has an application of ours
                     to attribute the daemon's file reads to (see SECURITY.md)
src/store.mjs       board JSON persistence: read, write, list, search
src/board.mjs       model: id minting, block normalisation, rounds, packet assembly
src/markdown.mjs    markdown -> HTML + anchor extraction (runs in node and the browser)
src/anchor.mjs      element-level (dom/mermaid) anchor path/hint logic, pure; src/ui.mjs
                     carries a duplicate as plain functions since the served page has no
                     import graph at runtime (see its file comment)
src/resolve.mjs     content-by-reference resolution and sha snapshotting
src/render.mjs      board JSON -> complete HTML page (pure function)
src/server.mjs      node:http daemon: routes, SSE, loopback Host check, read + write auth
src/secret.mjs      the two credentials: the local secret (where it lives, constant-time
                     comparison) and the browser session cookie derived from it; shared
                     by the daemon and the shim
src/handoff.mjs     single-use, seconds-lived browser handoffs, and the recovery command
                     every refusal names
src/indexpage.mjs   daemon root: the thread index and its session filter
src/ui.mjs          client-side script, exported as a string
src/styles.mjs      page CSS, exported as a string
src/theme.mjs       client-side theme selection: storage key, THEME_CHANGE_EVENT, the
                     pre-paint boot script, and the control's markup. src/render.mjs and
                     src/indexpage.mjs splice themeBootScript/themeToggle() into the page
                     they emit; src/ui.mjs imports only THEME_CHANGE_EVENT, baked into its
                     own separately-emitted client script. themeBootScript's inline
                     <script> in <head> and ui's <script type="module"> at end of body are
                     two independently-loaded contexts with no shared scope, agreeing on
                     that event name with nothing at build time enforcing it
src/patch.mjs       pure board-JSON diff (added/changed block ids, rounds now sent),
                     walking nested blocks too; imported directly by the checks AND
                     spliced verbatim into src/ui.mjs via computeBoardPatch.toString(),
                     so one implementation runs in node and in the page
src/prose-check.mjs the shared prose-vs-shim checker (SPEC_MIGRATION.md ticket 03):
                     parse a prose file, compare what it says it posts against the shim's
                     live tools/list and PROTOCOL.md's own block/widget/status vocabulary.
                     Ships from `src/`, not `test/`, so a caller outside this repo can
                     still import it; see "The prose-vs-shim checker" below and
                     test/check-prose-check.mjs, which proves it against a fixture this
                     repo owns
src/cues.mjs        the cue vocabulary (CONTEXT.md "Cue", ADR.md entry 20): the closed set
                     of legal cue values, enumerated live from /System/Library/Sounds plus
                     "None", read once and shared by the settings validator, the per-phase
                     defaults, and the preview player
src/pomodoro.mjs    the global pomodoro clock: the pure boundary rule (settleBoundary,
                     startWork, the cycle and its two resets), the document's shape on
                     disk, and the impure shell the daemon boots. Absolute deadlines, so
                     a restart is invisible and a deadline slept through expires silently
src/notify.mjs      one native macOS notification per interval boundary, carrying that
                     phase's cue (src/cues.mjs): the bundle's own executable in --notify
                     mode when running from inside claude-board.app (bin/launcher.c,
                     bin/notify.m, ADR.md entry 19), osascript only on the no-launcher
                     clone install. Message text and the cue both come from closed-set
                     lookups, so nothing user-controlled reaches the AppleScript interpreter
src/pomodoro-widget.mjs
                     the timer's server-rendered markup for the index page (countdown, the
                     start/pause switch, the two-step reset and the cogwheel settings
                     panel); the client half extends src/indexpage.mjs's script by
                     concatenation
skills/claude-board/SKILL.md
                     the manual for the `ask` tool, and the only prose statement of the
                     protocol a caller reads. install.sh step 6 copies it to
                     ~/.claude/skills/claude-board/ (ADR.md entry 11); every caller names
                     it instead of restating it, and test/check-skill-prose.mjs binds it
                     to the live shim
test/check-pure.mjs test/check-http.mjs test/check-mcp.mjs
test/check-install.mjs test/check-prose-check.mjs test/check-skill-prose.mjs
test/check-pomodoro.mjs test/check-notify.mjs test/check-pomodoro-page.mjs
test/check-install-doc.mjs test/run.mjs
install.sh
```

Zero dependencies: `node:*` built-ins only, ESM (`.mjs`) throughout, no bundler, no build
step. Mermaid is the sole exception and stays client-side from its CDN.

## Paths

The store root is `CLAUDE_BOARD_HOME`, defaulting to
`~/Library/Application Support/claude-board`. Unlike the other env vars here, this one is
user-facing configuration as well as the seam the checks run against.

```
$CLAUDE_BOARD_HOME/boards/<boardId>.json    the board document, the only mutable truth
$CLAUDE_BOARD_HOME/pages/<boardId>.html     emitted projection, standalone-openable
$CLAUDE_BOARD_HOME/pomodoro.json            the pomodoro clock and its settings (ADR entry 8)
```

`pomodoro.json` is the one thing here that is not a board, and the one thing `uninstall.sh`
removes from this directory — by exact name, never a glob. It is configuration this repo
authored (a deadline, a break length), not review history the user accumulated, which is why
it goes while `boards/` and `pages/` stay. See `src/pomodoro.mjs` for the document shape.

Daemon listens on `127.0.0.1:7391` (`CLAUDE_BOARD_PORT` overrides, for the checks).

## Identifiers

`th_<8 lowercase hex>` for threads, `b_<32 hex>` for boards, `q1` / `c3` / `m2` … for blocks
(kind letter + ordinal within the board, stable once minted). Comments are numbered `1..n`
across the whole board — that number is what appears in the pin.

The board id is 16 bytes, widened from 4 (audit 2026-07-28, M7). At the time read routes
were open, which made the id the de facto capability gating `GET /b/:id`; reads are gated
now, so the id is defence in depth rather than the only defence — and 16 bytes stays,
because an id also appears in redirect targets and in whatever a reviewer pastes into
chat. Thread ids stay 4 bytes — a thread is an index label and authorises nothing.

A block id is **unique across the whole board** (additive, audit 2026-07-28): `board.answers`
is keyed by it, so a duplicate is not a cosmetic clash, it is the agent being told an answer
the reviewer never gave. A caller-supplied `raw.id` is legitimate only on the amend
"replace this exact block" path, and is refused unless it (a) matches the minted shape,
(b) carries the kind letter of the block it names, and (c) is either unused or names a
top-level block of the round currently being amended. `addRound` refuses every id already
on the board.

Kind letter, one per block kind (`m` is mermaid per the worked example above, so markdown
uses `d` for document to avoid the collision):

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
  rounds: [ { n, postedAt, status, sentAt, title } ],   // status: 'open' | 'sent'
  blocks: [ Block ],                // every block of every round, in display order
  answers: { [questionBlockId]: Answer },
  comments: [ Comment ],
}
```

Answers are keyed at board level rather than nested in rounds; every block carries its own
`round`, which is what the history rail groups by.

**Round `title`** (additive, audit 2026-07-28). Every round carries the `title` of the post
that created it — `ask` requires a non-empty one on every call, and `/grill` (which lives in
the caller's own repo, [ADR 5](ADR.md)) tells the agent to make it the branch name.
`createBoard` seeds round 1's from the board title,
`addRound` takes the post's (falling back to the board title), and `amendRound` may refine
the open round's but never blanks it. `src/render.mjs` renders it in the round heading:
`Round 2 · fix/some-branch`, plus ` · sent` once the round is out. Previously the value was
posted, passed to `addRound`/`amendRound` and dropped there, so a thread that ran five rounds
across five branches showed five identical `Round N` headings.

### Blocks

Every block has `{ id, round, kind }`. Content blocks additionally carry the resolved
snapshot — `text` (`html`, for an `html` block) and `sha` — written once at post time and
never re-read (see "Questions by value, content by reference, snapshotted at post time").

```js
{ kind: 'markdown', source: Ref|null, text, sha, html, anchors: [Anchor], error? }
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

**`html` may carry a `source` too** (additive 2026-08-04, SPEC_HTMLREF.md; ADR.md entry 7).
Until now `html` was the one kind with no `source` at all, on the reasoning that a
hand-mocked stage has no file behind it to point at — that stopped covering the case of an
agent that renders a real page to disk and wants to put it on a board without re-emitting
the bytes as generated tokens. It now resolves through the same reader, the same
confinement, the same 512 KiB cap and the same block-level `error` behaviour as `markdown`,
`code` and `mermaid` (see "Reference confinement and caps" below). It is the one exception
to what a `Ref` may carry: `lines` and `section` are refused, with a block-level `error`
naming markup slicing as the reason — never silently ignored, never a throw. The other
kinds slice because cutting text at a line boundary still yields text; cutting markup at a
line boundary yields unclosed tags and orphaned `<style>`, which renders as a broken stage
and reads like a board bug rather than a documented limit.

A widget outside that list is a **400**, not a silent fallback to `single` (additive, audit
2026-07-28) — `{ widget: 'freetext' }` rendered a question with no cards and no textarea,
which Send then reported back as `unanswered`, so the agent misreported an unanswerable
question as "the reviewer left it blank". A `single`/`multi`/`rank`/
`choose-between-rendered-variants` question with zero options is a 400 for the same reason;
`text` needs none.

**`choose-between-rendered-variants`** (additive, SPEC_MIGRATION.md criterion 2) is the one
widget whose options are not `{ preview }` strings: each option's `block` is a real content
block of any kind, normalized the same way a `compare` side's own `block` is — same
`normalizeBlock`/`resolveBlockId` path, the same shared id ledger a post's other blocks
compete against, so it mints a real, unique block id rather than an inert string. It renders
through the same block dispatch every other content block does, so a comment can anchor to
an option's block, at least at the whole-block level, exactly like a `compare` side's or a
question's own `context` block's. The reviewer picks by clicking the option's own rendered
block rather than a label on a text prompt, but the answer shape does not change: `choice` is
still the picked option's `label`, a plain string, identical to `single`.

An option's block is untrusted, agent-authored content, same as any block on the page — but
here a click deciding WHICH option gets picked is a decision only the reviewer may make, and
an `html` option is a sandboxed iframe that can run the agent's own script. So the iframe is
rendered non-interactive (`pointer-events: none`) wherever it renders as an option: a real
click over the visible mock can never reach it, only the card around it, which is the sole
thing that can ever record a pick. The html-stage postMessage protocol (`src/render.mjs`,
`src/ui.mjs`) carries no message that could select an option on the stage's own say-so — that
was tried and reverted before this shipped; see `src/render.mjs`'s "NO 'select' MESSAGE,
DELIBERATELY" design comment. One consequence: an `html` option's own element-level
comment-anchor gesture is unreachable too, the same way its click is — the other content
kinds (markdown/code/mermaid/compare) render inline with no iframe at all, so theirs is
unaffected, and every option's whole-block comment button still works regardless of kind (it
renders in the parent document, not the iframe).

No caller in this repo posts this widget yet — `/example` is its real caller, and ships
outside this repo (see "The skills stay personal" in SPEC_MIGRATION.md).

`error` (additive, ticket 03): when a block carries `source` and `src/resolve.mjs`
fails to resolve it (missing file, out-of-range lines, section not found), the block
is still minted and kept — `text` (`html`, for an `html` block) comes back `''` and `sha`
the hash of the empty string — with `error` set to a human-readable reason. The page
renders the block with that reason visible instead of silently dropping it or aborting the
whole post. A block with no `source` (by-value content) never sets `error`.

**`cwd` is bound once, per thread** (additive, audit 2026-07-28). `cwd` is the board's own
project directory, and one of the two places a reference below may resolve — the other
being the configured reference roots, described under "Reference confinement and caps".
It is the only one of the two a *caller* chooses, which is what makes pinning it worth
doing: confinement is vacuous if a later post can move it. So it is accepted only on the
post that creates the thread, and is validated there (a **400**, since there is a caller
to tell):

```
relative                             refused: it would resolve against the daemon's own cwd
not an existing directory            refused
the filesystem root                  refused
$HOME, or any directory above it     refused: every project at once, plus keys and history
```

The value stored on the board is the **realpath**, so what the board records is the actual
directory its content came from. A post carrying `boardId` may repeat the board's own `cwd`
but may not change it; a post naming an existing `thread` inherits that thread's directory
(`createBoard`'s additive `threadCwd`) and may not change it either. A board with no `cwd`
resolves no references at all — it does not fall back to the daemon's own working
directory, which is a directory nobody chose and no board records.

This bounds and stabilises the read; on its own it does not authenticate the caller. That
last step is now closed by the local secret (see "The local secret" below): a board can only
be created, and therefore a `cwd` can only be named, by a caller holding it.

The thread's directory is looked up **server-side**, from the oldest board in the thread,
and passed to `createBoard` as `threadCwd` — the caller does not get to assert what the
thread is bound to. A post naming an existing `thread` and a different `cwd` is a **400**
(`cannot retarget thread: ...`) and creates nothing.

**Reference confinement and caps** (additive, audit 2026-07-28; allowlist added
2026-07-30, ADR.md entry 3). A `Ref.path` names a file *inside the board's `cwd`, or
inside one of the configured reference roots*, and nothing else. Every violation is an
`error` on the block — never a throw, never a read:

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

The last three are decided on the **open file descriptor**, not on the path a second
time: a reference is opened exactly once, refusing to follow a symlink in any component
while it does, and the type, size and byte guards all interrogate that descriptor. A path
is a name, and checking a name and then re-opening it leaves a gap in which anything that
can write inside the boundary can change what the name means (audit 2026-07-31). Which
refusal comes back is likewise decided only on names inside the boundary — a reference
that exists but does not resolve inside it reports the same thing whether its target is
absent, unreadable or simply elsewhere, so a refusal is never an existence probe for the
rest of the disk.

The reference roots are `CLAUDE_BOARD_REF_ROOTS` (colon-separated absolute paths). They
exist so a session can render the skill, command or agent file it is discussing rather
than a refusal box, and so a page it has just rendered to disk can be referenced rather
than inlined. The default `install.sh` writes into the launchd plist is exactly four
directories: `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents` and
`~/Documents/renders`. An
*absent* variable means no allowlist at all — the `cwd`-only boundary — deliberately, so
that a default living in code cannot widen the boundary on a machine that never
reinstalled; an explicitly empty value means the same thing. Each root is validated
exactly as `cwd` is above — realpath'd, must be an existing directory, refused if it is
`/` or `$HOME` or above, the last decided on `dev`+`inode` rather than on spelling since
macOS gives `$HOME` several equally canonical paths. A root failing any of that is dropped
rather than widened or fatal, and a spec that cannot be parsed as written (an entry that
is not an absolute path, which is what a directory name containing `:` degenerates into)
grants nothing at all. The daemon runs under launchd, so the value reaches it through the
plist `install.sh` generates; see `SECURITY.md`.

A markdown `section` is located with the same fence-aware scan `src/markdown.mjs`
uses, so the slug the agent is shown for a heading is the slug that resolves.

The same 512 KiB cap applies to by-value `text` and `html`, where it is a **400 on the
post** rather than a block-level `error`: by-value content came from the caller, so
there is a caller to tell. A `source` ref never raises this cap, for `html` or any other
kind: `src/resolve.mjs` checks the whole file's size from `fstat` before any of it is
read, so a 600 KB file behind a reference is refused exactly as a 600 KB file posted by
value is, just as a block-level `error` rather than a 400.

### Answers, comments, anchors

```js
Answer  = { id, status, choice, note }
          // status: 'answered' | 'unanswered' | 'deferred'
          // choice: string (single, text) | string[] (multi) | string[] ordered (rank) | null
          // note is always present, '' when empty. unanswered is explicit, never a default.

Comment = { n, blockId, anchor, text, createdAt, round }

Anchor  = { kind: 'block' }                             // whole block
        | { kind: 'md',      ref, label }               // heading slug + ordinal
        | { kind: 'dom',     ref, hint }                // "N.N.N" child-index path + a composed hint,
                                                         // see below -- applies page-wide, not just to
                                                         // an html stage (DESIGN.md ticket 03)
        | { kind: 'mermaid', ref, domRef, hint }        // node id, plus the same "N.N.N" path + hint
                                                         // every other element-level anchor carries;
                                                         // ref is the fallback the generic domRef/hint
                                                         // leans on, never the model (DESIGN.md
                                                         // ticket 05) -- domRef/hint are absent on an
                                                         // anchor minted before that ticket
```

Markdown anchor ids are the heading slug, plus `-liN` for the Nth top-level list item under
that heading: `acceptance-criteria`, `acceptance-criteria-li4`. Stable while the section's
shape is unchanged. An anchor of any kind that no longer resolves at render time is
reported, not dropped: the comment survives with `resolved: false` and a `lost` field
naming what it lost (`src/board.mjs`'s `lostLabel`) — the stored `hint` for a `dom` anchor
or a `mermaid` anchor minted since ticket 05 (DESIGN.md), the bare `ref` for
everything else, including a `mermaid` anchor minted before that ticket (no `hint` to fall
back to).

Additive (audit 2026-07-28), all three keeping ids unique and resolvable:

- **Top-level list items that precede every heading** anchor under the synthetic section
  prefix `_body`: `_body-li1`, `_body-li2`. Criterion 5 states the rule unconditionally,
  and a headingless source (a bare criteria list) previously yielded zero anchors. The
  underscore is what makes the prefix safe: `slugify` strips `_`, so no heading can ever
  produce this string.
- **Slug and label come from the RAW heading text**, before HTML escaping. `## Risk &
  Reward` is `ref: 'risk-reward'`, `label: 'Risk & Reward'` — the same slug
  `section: 'risk-reward'` resolves, and a label every consumer escapes exactly once.
- **A quoted (`>`) heading or bullet mints no anchor and carries no id**, and consumes
  neither a slug nor a `-liN` ordinal.

A `dom` ref's index chain is 1-based over `Element.children` **as the browser parses the
markup** — implied `tbody`, auto-closed `p`/`li`/`tr`/`td`/`option`, and `script`/`style`
counted as elements. `src/ui.mjs` mints it against the live DOM and `src/anchor.mjs`
resolves it against the snapshot; the two trees have to agree node for node or a live
element reports lost.

A `dom` anchor's root depends on which block it names (DESIGN.md ticket 03/04):
for an `html` block, root is that stage's sandboxed iframe body, resolved by
`resolveDomAnchor`; for the other content kinds (markdown, code, and a `mermaid` block's
own chrome), root is the anchored block's own `<section data-block-id>`, re-rendered from
its stored content (`src/render.mjs`'s `renderBlock`) and resolved by
`resolveDomAnchorInSection`. This is what makes a `dom` anchor page-wide — any element the
board renders as content can carry one, not only content inside an html stage.

**A `question` or `compare` section is never a `dom` anchor root.** Those two kinds render
no content of their own — a card around a widget, a grid around two nested blocks — and
carry no comment area, no pin-layer and no click-to-anchor gesture at all; `src/ui.mjs`
refuses the root by `data-block-kind` before minting. What is nested inside them is
unaffected: a question's `context` entry and a compare side's block go through the same
`renderBlock` dispatch with their own `data-block-id`, and each is a root in its own right
under the rule above. See `ADR.md` entry 6, "Commenting is confined to content blocks".

`hint` is not a bare text snippet either. `composeHint` (`src/anchor.mjs`, mirrored
client-side in `src/ui.mjs`) starts from the clicked element's own text, falling back to a
role word (`button`, `link`, `field`, `image`, `menu`) for a handful of role-bearing tags
with none, or the tag name for anything else empty. Only inside one side of a `compare`
block does it go further: the role word is appended after real text too (`"Send button"`,
not just `"Send"`), and the whole identity is suffixed with `" in <context>"`, where
`<context>` names that side's label plus the block kind it holds (`"Before html stage"`,
`"After diagram"`). Outside a compare, a hint is exactly the plain snippet it always was.

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

`posted` (additive, ticket 01) means the round carried no question block anywhere in it —
top-level, or nested in a question's `context` or a `compare` side — so there was nothing to
submit and the shim returned the instant the post succeeded rather than waiting on
`/api/board/:id/wait` at all. `answers` and `comments` are always empty on a `posted` packet:
nobody has answered or commented yet, because nobody was asked to. `discuss` means the
reviewer chose Discuss in chat: partial answers are included and the agent must stop posting
boards for the rest of the session. `timeout` is the wall-clock cap (default 2h) and carries
an explicit no-response.

**Scope: one packet is one round** (additive, audit 2026-07-28 — this was previously
unpinned, which is why it diverged). `answers` holds exactly the question blocks whose
`round` is the packet's `round`, and `comments` exactly the comments left in it. Round 6
does not redeliver rounds 1-5: the agent would re-address settled feedback and re-report an
old `unanswered`/`deferred` as a fresh signal, louder each round. Every entry additionally
carries its own `round` (and each comment its `createdAt`), so a caller that genuinely
wants the thread's history reads `board.answers` / `board.comments` and can still tell the
rounds apart. The stored board keeps everything; the packet is the round.

**`status` is the only thing that says whether a question was decided; `choice` is not.**
A caller must branch on `status` and never on `choice` being non-null, because the three
statuses do not agree about `choice`:

- `answered` — `choice` holds the answer.
- `deferred` — `choice` may ALSO hold a selection. The reviewer can pick an option and
  still mark it "revisit later", and that tentative lean is worth carrying rather than
  discarding. A caller that reads `choice` alone therefore records a decision the reviewer
  explicitly declined to make.
- `unanswered` — `choice` is `null`.

Found by using this: a round came back with a `deferred` question whose `choice` was
populated beside an `unanswered` one whose `choice` was `null`, and nothing here said which
was the contract and which was an accident.

`answers` covers **every** question block of that round, including ones nested in another
question's `context` or in a compare side — the renderer makes those live widgets and the
page submits them, so dropping them would lose an answer the reviewer actually gave. An
answer whose id is not a question block of the round being submitted is ignored server-side
rather than stored.

## HTTP surface

Posting and waiting are separate routes on purpose, so the spec's escape hatch (splitting
`ask` into post + collect) stays cheap. Every route refuses a request whose `Host` header
is not loopback, with 403 and no body.

Four gates, in order: loopback `Host` (403), same-origin on every non-GET (403), a
credential on every non-GET (401), a credential on every GET but two (401). Both credential
gates are written as "everything, minus an explicit exception list", so a route added later
is gated by default rather than by whoever adds it remembering.

The Host check does not cover a browser: a page on any origin doing
`fetch('http://127.0.0.1:7391/...')` has its `Host` set to loopback by the browser itself.
So every non-GET additionally refuses (403, no body) when `Origin` is present and is not
the daemon's own origin, or when `Sec-Fetch-Site` is present and is not `same-origin`, and
every body must be `Content-Type: application/json` (415 otherwise) — `text/plain` and the
form encodings are CORS simple requests and need no preflight. Non-browser clients (the
shim, curl, the checks) send neither header and are unaffected. Every HTML response also
carries `X-Frame-Options: DENY` and a `frame-ancestors 'none'` CSP.

### `GET /file/<path>` — a file served as-is

`/file/<path>` answers with the bytes of a file inside `CLAUDE_BOARD_SERVE_ROOTS`, unchanged:
no board chrome, no block wrapping, no slicing, no byte cap. It exists for the documents the
render skills write, which are whole HTML pages with their own vendored diagram engine — a
thing a board block cannot carry, because a stage is floored at 320px and the board CSP names
no `'self'` for the engine to load from. A board links to one; it does not embed it.

- `CLAUDE_BOARD_SERVE_ROOTS` is colon-separated absolute directories, `~` expanded, validated
  exactly as `CLAUDE_BOARD_REF_ROOTS` is (realpath, must exist, never `/` or `$HOME`, an
  unusable entry dropped, a non-absolute entry failing the whole spec closed). **Absent means
  empty, so the route is off**; `install.sh` writes the default (`~/Documents/renders`).
- It is a **separate** allowlist from the reference roots, and the escalation is why: a
  referenced file is escaped into a block, a served one is a live document at the daemon's own
  origin. One shared list would have widened every existing install on a `git pull`.
- The path resolves against each root in order, first regular file wins. A directory resolves
  to `index.html` inside it — the daemon serves files, it never enumerates a directory.
- Behind the read gate like every other non-open route: an authorized browser only.
- Every refusal is the same bare 404 — traversal, an escaping symlink, a fifo, a missing file
  and an unconfigured allowlist are indistinguishable, so the route is not an existence oracle.
- Served responses carry their own CSP, not the board's: `script-src 'self'` (so the document
  loads its own engine) but `connect-src 'none'` and `form-action 'none'`, which is what stops
  a served page from riding the same-origin session cookie into `/api/board/<id>/submit`.
  Plus `nosniff`, `X-Frame-Options: DENY` and `Cache-Control: no-store`.

### The local secret

Additive, audit 2026-07-28; `DESIGN.md` Decisions → "A loopback Host check, an origin
check, and a local secret". The Host check closes the network and the origin check closes
the browser. Neither can see a **local process**: anything able to open a socket to
`127.0.0.1:7391` could post its own board naming a `cwd` it picked and read that directory
back off the served page — and because the daemon runs always-on under launchd as the login
user, that read is laundered past macOS TCC, which would otherwise gate `~/Documents`,
`~/Desktop` and `~/Downloads` per application.

```
~/.config/claude-board/secret      0600, in a 0700 directory; 32 random bytes as hex
                                   generated by install.sh, NEVER rotated by a reinstall
                                   (CLAUDE_BOARD_SECRET_FILE relocates it, for the checks)
x-claude-board-secret: <secret>    request header; read once at daemon startup, compared
                                   with crypto.timingSafeEqual, length-guarded
```

**Every non-GET request** must carry it — except `POST /api/board/:id/submit`, which also
takes the session cookie below — so a write route added later is gated by default rather than
by remembering. A missing or wrong credential is **401 with no body** on a write: nothing
about what is behind it, not even whether the board exists. A daemon that finds no secret
file says so on stderr at startup and refuses everything gated: it fails closed, never open.
`bin/mcp.mjs` reads the secret at startup, sends it on every call, and refuses to post at all
(naming `./install.sh`, writing nothing) when it has none or the daemon answers 401.

### The browser session cookie

`SPEC_LAUNCH.md` Decisions → "Read routes are gated", overturning `DESIGN.md`'s "read
routes stay open". **Every route but `GET /api/health` and `GET /auth/:token` now requires a
credential**, reads included: `GET /`, `GET /b/:id`, `/api/search`, `/api/board/:id/wait` and
the SSE stream. What that closes: any local process that could reach the port used to read
every board — source excerpts, questions, answers — and forge an answer on any board whose
page it could fetch.

The browser cannot read a 0600 file, so it holds this instead:

```
Set-Cookie: cb_session=<HMAC-SHA256(secret, "claude-board/session/v1")>;
            Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict
```

Host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, and **not** a session cookie: a
bookmarked board opened days later has to work. No `Secure`, and none is possible — the
daemon serves plain http on loopback, so a `Secure` cookie would never be sent back.

**Derived from the secret, not random**, which is what makes it survive a daemon restart:
any daemon holding the same secret accepts the same cookie, so `launchctl kickstart`, a
crash and a code reload are all invisible to an open browser. Rotating the secret invalidates
every browser at once — intended.

Its strength, precisely: "may read every board and answer any open round". It is refused in
the `x-claude-board-secret` header, so it can never create a board and therefore never make
the daemon resolve a file. It is **not** scoped to one board; the board-scoped submit
cookie that used to sit beside it — an HMAC of the board id, minted for whoever could fetch
that board's page — is deleted, because with reads gated it was strictly weaker than the
credential the reader already had to present.

Widened, ticket 03: it is also accepted on the pomodoro writes — `ensure`, `pause`,
`resume`, `reset`, `settings`, `preview` — so the index page's switch and its settings
popover (a browser holding only the cookie) can actually start, pause and resume the clock,
and audition a cue. Driving an advisory clock that never touches a board, never gates an
`ask`, and never reaches a tool is strictly less than "may read every board and answer any
open round", so this costs the cookie nothing it did not already carry. `ensure` was
initially excluded, on the reasoning that its only caller was the session-start hook; it was
added when the index widget grew a manual start, and it is one of the mildest of the six —
`startWork` is a no-op against any timer that already exists, so the most it can do is begin
a clock that `reset` (already on the list) could have ended anyway. `preview` joined for the
same reason and is milder still: it reads and writes nothing, so the most a cookie holder
gains from it is spawning `afplay` against one of the sounds `src/cues.mjs` admits. The list
stays a closed, named set: a pomodoro write added later is secret-only until someone
deliberately names it.

### Authorizing a browser

A credential never appears in a URL a bookmark can capture. Instead:

```
POST /api/handoff       { boardId? }  (secret required)  -> { token, expiresAt, ttlMs }
GET  /auth/<token>      302 -> /b/<boardId> (or /), Set-Cookie: cb_session=…
```

`POST /api/handoff` mints a **single-use, ~30s** token (`CLAUDE_BOARD_HANDOFF_TTL_MS`
overrides, for the checks). It takes the secret only — the session cookie is refused here, so
a browser cannot mint itself a second credential. The caller names a *board*, never a path:
anything that is not a board id redirects to the index, so there is no attacker-chosen
redirect target to validate.

`GET /auth/<token>` consumes it, sets the cookie, and redirects to a **clean** URL. Expired,
already used, and never existed are one indistinguishable refusal. The token is process-local
state, so it does not survive a daemon restart — the opposite of the cookie it hands out, and
deliberately so.

The shim opens the tab on a handoff URL rather than a board URL, and rebuilds that URL from
its own base URL and the returned token rather than trusting anything in the response body.

`node bin/authorize.mjs` (`npm run authorize`) is the recovery command: it mints a handoff
and opens the browser. `--print` emits the URL instead, for a second profile or a different
browser; an optional board id argument lands on that board rather than the index. The refusal
page below names this command with an absolute path, and `src/handoff.mjs` `recoveryCommand()`
is the single source of that string.

### Refusing a caller with no credential

**401, one status code everywhere**, matching what writes have always answered. No
`WWW-Authenticate` header: it would raise a browser password prompt in front of the page that
explains the actual fix, and there is no password to type.

A **browser navigation** (a path outside `/api/` whose `Accept` includes `text/html`) gets an
HTML page naming the recovery command verbatim, because the caller being refused is a human
looking at a tab. Everything else — `/api/*`, the SSE stream, curl, the shim — gets
`{ error, recover }` as JSON and no markup. Neither reveals anything about the store: the
same page is served whether or not the board exists.

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
POST /api/board/:id/submit          { action: 'send'|'discuss', answers, comments }
GET  /api/search?q=                 archive search
GET  /api/pomodoro                  the pomodoro document -> { settings, cycle, cycleDate, timer, now }
POST /api/pomodoro/ensure           ensure a timer exists; no-op if one already does (any phase)
POST /api/pomodoro/pause            freeze the running interval
POST /api/pomodoro/resume           continue a paused interval from where it froze
POST /api/pomodoro/reset            end the loop: timer -> null, cycle -> 0
POST /api/pomodoro/settings         { workMin?, breakMin?, longBreakMin?, longEvery?, notify?,
                                    cueWork?, cueBreak?, cueLongBreak? }
                                    merged into the stored settings, not replaced
POST /api/pomodoro/preview          { cue } -> { ok: true }; plays a cue immediately, reads
                                    and writes nothing
POST /api/pomodoro/notifyTest       no body -> { ok: true }; raises one test banner
                                    immediately, reads and writes nothing
```

### The pomodoro clock (ADR.md entry 8)

`GET /api/pomodoro` returns the whole document (`src/pomodoro.mjs` `defaultDoc`) plus
`now`, the daemon's own `Date.now()` at response time — the page renders a countdown by
subtracting a deadline from a clock, and the client's clock is not the daemon's, so `now`
lets it compute `serverNow - Date.now()` once and keep subtracting that offset rather than
trusting the browser's own clock against a server-minted deadline. Every write route below
(`ensure`/`pause`/`resume`/`reset`/`settings`) returns the same `{ ...document, now }` shape,
reflecting the state immediately after that write.

`POST /api/pomodoro/ensure` is *ensure*, never *start*: it begins a fresh work interval only
when there is no timer at all. A running timer, a paused timer, and a timer mid-break are
each left untouched — the guarantee ticket 05's session-start hook depends on: a second
session, a `/clear`, a resume, or a session in another project while a timer runs is a
no-op, and starting mid-break does not cut the break short. It is deliberately callable with
**no body at all** — `readJsonBody` is never invoked on this route — so a one-line
`curl -X POST` from a shell hook works with no `content-type` and nothing to parse.

`POST /api/pomodoro/pause` converts the running interval's absolute `deadline` into a
`remainingMs` snapshot and sets `paused: true`; `POST /api/pomodoro/resume` reverses that —
`deadline = now + remainingMs`, `paused: false` — so the interval continues from where it
froze rather than restarting. Both are no-ops in the states where they make no sense
(pausing nothing, pausing an already-paused timer, resuming a timer that is not paused).
`POST /api/pomodoro/reset` clears `timer` to `null` **and** `cycle` to `0` — reset ends the
loop, so the cycle it was counting goes with it.

`POST /api/pomodoro/settings` merges a partial patch into the stored settings rather than
replacing them, and validates at this trust boundary: every duration and `longEvery` must be
a finite integer in a sane range (`longEvery` at least 1 — `settleBoundary` divides by it),
`notify` must be a real boolean, and each of `cueWork`/`cueBreak`/`cueLongBreak` must be the
name of a sound in `/System/Library/Sounds` or the string `"None"` — the closed set
`src/cues.mjs` reads live off that directory (ADR.md entry 20), not a fixed list. A patch
that fails validation is a 400 naming the offending field (`{ error }`) and writes nothing,
not a silent partial write. Unknown keys in the patch are dropped rather than stored or
rejected. Changing a duration does **not** retarget whatever interval is already running —
the new value applies starting at the next boundary crossing.

`POST /api/pomodoro/preview` auditions a cue: `{ cue }`, where `cue` must satisfy the same
`isCue` check `settings` validates `cueWork`/`cueBreak`/`cueLongBreak` against, with `"None"`
a legal choice that previews as silence rather than a 400 — a reader has to be able to
audition "nothing" too. It reads and writes nothing (not `pomodoro.json`, not
`settings.notify`), on purpose: this is an audition, not a setting, so it plays even while
the notify toggle is off, and it never returns the document shape — `{ ok: true }`, not
`{ ...document, now }`. It plays the sound file directly with `afplay` rather than posting it
through Notification Center, so auditioning a cue never raises a banner, and a newly
selected cue kills whatever preview is still playing first, so a fast run of picker changes
never overlaps into a chorus.

Auth: `GET /api/pomodoro` is gated like every other read (either credential). All seven
writes (`ensure`, `pause`, `resume`, `reset`, `settings`, `preview`, `notifyTest`) accept
the session cookie in addition to the secret, which is what lets the index page's switch and
its settings popover work from a browser holding only the cookie (see "The browser session
cookie" below for the reach this extends). `notifyTest` is the settings popover's other
audition, and sits on the same footing as `preview`: its one caller is the Notify checkbox in
that popover, it reads and writes nothing, and what it grants is one banner whose sentence is
a literal out of `src/notify.mjs`'s closed table, with no request body to supply one. It
ignores the stored `notify` setting on purpose, since the tick that triggers it has not been
saved yet. `preview` is cookie-reachable for the same reason `ensure` is:
its one caller is the settings popover's picker, a browser holding only the cookie, and what
it grants that caller is advisory — at most spawning `afplay` against one of the sounds
`src/cues.mjs`'s closed set admits, less reach than `settings`, already on this list, which
lets the same caller rewrite every duration and toggle in the document. `ensure` has two
callers, not one: ticket 05's session-start hook (holding the secret) and the index widget's
switch when the reader starts a pomodoro by hand.

`POST /api/board` body shape (additive — not pinned above): `{ title, blocks, cwd?, thread? }`
to start a new thread, or `{ boardId, blocks, title? }` to push into a live one. `cwd` is only
meaningful on the thread-creating form and is validated there (see "`cwd` is bound once,
per thread" above); on the `boardId` form it may repeat the board's own value but never
change it. `title` is meaningful on **both** forms: on the `boardId` form it labels the round
being minted or amended (see "Round `title`"). Pushing into a live
board amends the currently open round in place (a block whose incoming id already exists on
the board replaces it, everything else is appended to that same round) when the latest round
is still `open`; it mints a new round only once the latest round's status is `sent`. Either
way the response is unchanged: `{ boardId, thread, round, url }`, `round` naming whichever
round was amended or minted.

`GET /api/board/:id/wait?round=N` has a server-side wall-clock ceiling matching
`CLAUDE_BOARD_TIMEOUT_MS` (default 2h): when it fires the call returns 200 with a packet
whose `status` is `timeout`, carrying whatever partial answers the store holds. A client
that disconnects ends the wait outright — nothing is written and the poll stops.

`POST /api/board/:id/submit` body shape (additive — not pinned above). `round` is
**required** and names the round being answered: a submit that omits it is a 400, and one
naming any round other than the currently-open one is a 409 whose body carries
`{ error, board, round }` with `round` naming the round that IS open (`null` when the
board has no open round at all), so a stale client can resync rather than silently
overwrite a sent round.

```js
{
  round: 1,                                        // required; must be the open round
  action: 'send' | 'discuss',
  round,                                           // additive: the round this submit is for
  answers:  [ { id, status?, choice, note? } ],   // status defaults to 'answered' when
                                                    // choice is present, 'unanswered' otherwise;
                                                    // any question block with no entry here is
                                                    // synthesised as unanswered server-side
  comments: [ { blockId, anchor, text } ],         // n, createdAt, round are assigned server-side
}
```

`round` (additive) names the round the page believed was open when the reviewer pressed the
button. It exists so a submit aimed at a round that has already been sent can be refused with
**409** instead of silently re-applying: without it, a second tab — or a plain double-click, since
the send bar sits outside the round section and so is never disabled by the history collapse —
appends the same comments a second time under fresh numbers, and re-applies answers to a round
that already went out. A client that gets a 409 treats it as "already sent" and stops offering to
send that round again; it is not an error state.

### The two ways out of a round

`action` is the whole difference between them, and the body is otherwise identical — the page
posts the same answers and the same queued comments either way, because `discuss` is defined as
returning *whatever is filled in*, not a degraded second path:

- `'send'`   → `board.state = 'submitted'`, packet `status: 'submitted'`.
- `'discuss'` → `board.state = 'discuss'`, packet `status: 'discuss'`; partial answers are
  included and the calling agent must stop posting boards for the rest of the session.

The page renders both as buttons in one `.send-bar` (`#send-btn`, `#discuss-btn`, `src/render.mjs`),
which `body.readonly` hides wholesale — so the standalone `file:` archive offers neither.

### Marking an already-open tab

"Open once, then badge and notify" (DESIGN.md) splits across two owners. Page side, on a
`round` push: a **countless** mark drawn onto a data-URI favicon (canvas, no asset file — the
page must stay a single self-contained file), and, only when the document is hidden or
unfocused, a `Notification`, which does carry the round number. `document.title` is left
alone — it used to take a `(n) ` prefix and no longer does (see CHANGELOG, "The pending-round
mark on a tab lost its number, not its mark"): knowing you owe an answer is worth a glance,
knowing it is three answers was not worth a second mark that could drift out of step with the
round count. Unmarked, the tab carries the board mark every page emits
in its `<head>` (`faviconLink`, `src/styles.mjs`): an inline `data:image/svg+xml` link, painted
from the dark palette's `--warning`/`--accent-ink`, so the same rule holds and the `file:` archive
shows the mark with the network off. The pending mark is that same tile inverted — a `--bg` ground
carrying a `--warning` pip, no digit — rather than anything added on top of it, because
`--warning` is also the "waiting on you" hue and at 16px the two states have to differ in value,
not merely in contents (ADR.md entry 12). The same mark, from the same rects, is what the board head's back control and the
index title carry (`markSvg`). Clearing the pending mark restores the unbadged one rather than
blanking the href. Permission is requested lazily on the first round that
would actually notify, and also on a Send click — the one moment the tab is definitely focused,
so Chrome raises the prompt in the foreground instead of queuing it. A denial is never re-prompted,
and every part degrades silently: a failure anywhere leaves the round pushed and the page working,
just unmarked. The page never pulls itself forward unbidden; the one exception is the
notification's own click, which calls `window.focus()` because a click on it is the reviewer
asking. That click then scrolls to the open round before dismissing itself, through the same
`jumpToOpenRound` the round badge uses — the badge's job is "take me to the thing that needs
an answer" and a notification click is the same request, so they share one implementation
rather than two that can disagree. It stays inert when the open round is already in view.
All of it is inert in readonly mode. The notification's `tag` carries the round number
(`claude-board-<boardId>-<n>`), so two unread rounds are two entries rather than one replacing the
other; only a genuine re-delivery of the same round collapses.
Shim/daemon side, unchanged: reopening the tab when no client is connected at all,
and printing the board URL in chat as the fallback that cannot fail.

## SSE events

`GET /api/board/:id/events` (additive to the HTTP surface above, ticket 04): a `text/event-stream`
subscription, one per connected client, for round pushes and submits on `:id`. 404s up front if
the board doesn't exist; otherwise the response never ends on its own — it stays open until the
client disconnects. Heartbeat comment lines (`: heartbeat\n\n`) keep it alive through idle timers
and proxies; `CLAUDE_BOARD_SSE_HEARTBEAT_MS` overrides the cadence (default 15000), for checks
only — never set by a user. Comment lines are invisible to `EventSource`'s message events, so
they never surface as a stray event to client code.

Two named events, both carrying the full board JSON (the same shape a served page inlines) so a
client can diff against its own last-known copy and update it, plus enough to apply the push
without a full reload:

```js
event: round      data: { round, mode: 'new-round' | 'amend', blockIds, html, board }
event: submitted  data: { round, board, html }
```

`submitted`'s `html` (additive, not in the original pinning of this event): the
re-rendered `<section class="round">` for `round`, now in its sent/history form — the
same `renderRoundSection` output a full page load would produce for it. Without it a
client that did not submit would have to disable its own on-screen copy by hand, which
leaves that tab showing its own unsent, in-progress state as if it were what was sent.
A client that receives no `html` must fall back to disabling the round in place.

`html` is a pre-rendered fragment covering exactly `blockIds` — never the whole page — so the
client only ever inserts or replaces that much DOM: `renderRoundSection`'s output (a full
`<section class="round">` wrapper) for `mode: 'new-round'`, or one `renderBlock` call per touched
id (no wrapper) for `mode: 'amend'`, since the round section the amended blocks belong to already
exists client-side. `submitted` fires on every submit, to every connected client including the one
that just submitted, so a second tab collapses the round into its history rail without reloading.

The client subscribes only when NOT running read-only from `file:` (see "Detecting a session with
no human in it" for the analogous shim-side rule; the page's own rule is `location.protocol ===
'file:'`, unconditionally, from `src/ui.mjs`) — the standalone archive stays network-free.

**Resync on every open** (additive; supersedes this section's earlier claim that a reconnect
"has missed nothing and needs no separate resync call"). That claim held only for a *daemon*
restart — nothing can mutate a board while the daemon is down — and does not follow for a
*client* disconnect, which is the common case: a sleeping laptop, a tab restored from the index
while the agent is mid-amend, a page served a moment before the round it is about to miss. The
stream carries no replay and the daemon emits no `id:` lines, so a broadcast that lands while a
client is disconnected is lost permanently, and the reviewer answers a round they cannot see the
whole of.

So on **every** `open` of the subscription — the first connection included — the client re-reads
the board and diffs it against its local copy with the same `computeBoardPatch` (`src/patch.mjs`)
every push uses, replaying the difference through the same apply path as a live push. A first
connection with nothing missed diffs to nothing and touches no DOM. The re-read is a plain
`GET /b/:boardId`: that page already inlines both the payload (`#board-data`, `resolveComment`
already run over it) and the server-rendered markup for every round, so the catch-up reuses the
exact fragments a live push would have carried rather than inventing its own. No new route is
required; a dedicated JSON route would be leaner and can be added later without changing this
rule.

## MCP surface

One tool, `ask`, on the stdio shim. It posts a board and opens the tab on the thread's first
board. Whether it then waits is derived from the round just posted, not from a mode flag or a
"no questions" guard: a round carrying a question block anywhere in it (top-level, or nested
in a question's `context` or a `compare` side) blocks on `/api/board/:id/wait`, emitting
`notifications/progress` throughout so the idle timer never fires; a round of content blocks
only returns the instant the post succeeds, packet `status: 'posted'` (see "Packet" above) —
there is nothing left to wait for. Round 7 pinned this on the post succeeding rather than on
the tab opening, which was the return condition originally written and was never
implementable: `open` is spawned detached and this process never learns whether a tab
actually appeared, so "the tab is open" was not a state it could observe. Opening a tab stays
best-effort and its failure stays non-fatal either way. Arguments mirror the board document:
`{ title, blocks }`, where question blocks carry their questions by value and content blocks
carry a `source` ref.

Failure is loud and writes nothing, on three triggers: an unreachable daemon (returns the
revive command), a non-interactive session (refused before anything is posted — see
"Detecting a session with no human in it"), or a session on which nothing can open a tab at
all (same section) — an SSH session on a machine with no display passes the first two checks
and would otherwise post a board nobody can see and block for the full wall-clock cap.

The shim tracks one thread per process (one shim per Claude session): the first `ask` call
starts a new thread and opens its tab; every later `ask` call in the same process pushes a
round into the same live board (`POST /api/board` with `boardId` set) and reopens the tab
only when no client is connected to that board at all — see "Open once, then badge and
notify". It never reopens a tab the reviewer already has open.

### MCP shim environment (additive to `CLAUDE_BOARD_HOME` / `CLAUDE_BOARD_PORT` above)

```
CLAUDE_BOARD_TIMEOUT_MS       wall-clock cap on the blocking wait, default 2h (7_200_000)
CLAUDE_BOARD_PROGRESS_MS      notifications/progress cadence, default 20_000 (20s)
CLAUDE_BOARD_HEADLESS=1       forces the non-interactive refusal regardless of entrypoint --
                               also the documented manual opt-out (ticket 01, criterion 10a):
                               set it deliberately on a machine that COULD open a tab, to use
                               the terminal for this session instead of ask
CLAUDE_BOARD_NO_OPEN=1        skip opening a tab at all (checks only; never set by a user) --
                               opening deliberately SUPPRESSED, which is why this does not
                               also trip the "cannot open a tab" refusal below: a real caller
                               never sets it, so that refusal only ever fires where it is unset
CLAUDE_BOARD_OPEN_CMD         command used to open the board URL, default `open` (checks
                               override this to something other than a real browser). Setting
                               this on a non-darwin machine is also what satisfies the
                               "cannot open a tab" refusal for real: it is the one way a
                               caller states that something CAN show a human the board
CLAUDE_BOARD_ASSUME_PLATFORM  overrides process.platform for the "cannot open a tab" decision
                               only (checks only; never set by a user) -- there is no second
                               OS on the machine that runs this suite to exercise the
                               non-darwin branch on for real
CLAUDE_BOARD_POST_TIMEOUT_MS  timeout on POST /api/board only, default 10_000; never applied
                               to the /wait call, which must survive the full wall-clock cap
CLAUDE_BOARD_SECRET_FILE      where the local secret lives, default
                               ~/.config/claude-board/secret. Read by install.sh, the daemon
                               and the shim alike; a testing seam, not configuration
```

## Detecting a session with no human in it

Measured on Claude Code 2.1.220, not extrapolated: an interactive terminal session exports
`CLAUDE_CODE_ENTRYPOINT=cli`, while `claude -p` exports `CLAUDE_CODE_ENTRYPOINT=sdk-cli`.
Both export `CLAUDECODE=1`, so that variable discriminates nothing.

The shim therefore treats interactivity as an **allowlist and fails closed**: post only when
`CLAUDE_CODE_ENTRYPOINT` is one of `cli`, `vscode`, `jetbrains`, `ide`, `claude-desktop`,
`claude-desktop-3p`. Any other value — and an absent value — is a session with nobody
watching, and `ask` refuses before anything is posted or written. `CLAUDE_BOARD_HEADLESS=1`
forces the refusal regardless, which is the hook an unattended runner sets.

Known residual gap, deliberately not papered over: `/nightly` and `/loop` run *inside* an
interactive session, so the entrypoint still reads `cli` and no env check can see them. That
half of acceptance criterion 11 is a rule those commands must carry (set
`CLAUDE_BOARD_HEADLESS=1`, or do not call `ask`), not a mechanism the shim can enforce.

**A third, distinct refusal: the daemon cannot open a tab.** SSH onto a machine with no
display is neither of the two cases above: it exports
`CLAUDE_CODE_ENTRYPOINT=cli`, which passes the interactivity check, and the daemon it talks
to over loopback is perfectly reachable. But `openBoardTab` (`bin/mcp.mjs`) silently no-ops on
a non-darwin platform with no `CLAUDE_BOARD_OPEN_CMD` configured — there is no mechanism at
all on that machine to put a tab in front of a human. Unrefused, that posts a board nobody can
see and blocks for the full wall-clock cap with nothing to report, so `ask` refuses it up
front instead, before anything is posted: platform is `darwin` (the `open` command always
exists), or `CLAUDE_BOARD_OPEN_CMD` names an explicit opener, or refuse. This is checked
independently of the interactivity allowlist above — a session can be interactive and still
have nowhere to show the board — and, symmetrically with `CLAUDE_BOARD_HEADLESS=1`, is not
tripped by `CLAUDE_BOARD_NO_OPEN=1` (see "MCP shim environment"): that flag means opening was
deliberately suppressed for this run, never that no way to open exists, and a real caller
never sets it.

## The prose-vs-shim checker

Prose drifts from the tool it describes and nothing catches it — a skill's `SKILL.md` or a
command's `.md` file says it posts an argument, a block kind or a widget that the shim no
longer has, and it silently stops being true. `src/prose-check.mjs` is this repo's one shared
checker: parse a prose file, compare what it says it posts against the shim's live
`tools/list` (and PROTOCOL.md's own "### Blocks" vocabulary), and fail loudly on drift. It
generalises what was `test/check-grill.mjs`'s hand-rolled version of the same idea before
`/grill` and its check moved out of this repo (ticket 04 / ADR.md entry 5), mining out the
parts that apply to any caller: the tool is named, its real argument names appear, no
argument/block-kind/widget is claimed that the shim does not have. The parts that were
specific to `/grill`'s own history (no HTML template, the old "one question per call" rule
being gone, the exact revive command) left with that command's prose — each caller's own
`check.mjs`, wherever it lives, is where its command-specific assertions belong now.

**An argument counts as named in either of two conventions, not one.** `commands/grill.md`
backticks each argument on its own (`` `title` ``); `/visualize`, `/explain` and `/gamify`
instead show a fenced worked example whose object keys ARE the argument names — either
`title: 'value'` or the ES6 shorthand `title,` (the local variable doubling as the key, e.g.
`ask({ title, blocks: [...] })`). The first version of this checker recognised only the
backtick convention, which failed all three of those real callers on arguments they name in
the clearest possible form (structure, not behaviour — see "Testing" in SPEC_MIGRATION.md).
Neither form is a bare substring match: both require the name to appear in object-literal
position (bounded by `:`, `,` or `}`) inside a fenced code block, or backticked — `title` and
`blocks` are ordinary English words, and matching them unscoped would make the assertion
vacuous.

**Its subject now lives here** (ADR.md entry 11, 2026-08-04). The checker was written for
callers outside this repo, each of which restated the protocol in its own words and needed
its own binding. That premise is gone: `skills/claude-board/SKILL.md` is the one place the
protocol is stated in prose, this repo ships it, and `test/check-skill-prose.mjs` runs the
battery below against it on every `node test/run.mjs`. The callers name that skill and claim
nothing of their own, so they have nothing left to drift.

That check goes one way further than this battery does. `checkProse` only rejects vocabulary
the prose **invents**; the manual has the opposite duty, since a widget it omits is a widget
no caller will ever reach for. So `check-skill-prose.mjs` also asserts **absence**: every
block kind, widget and packet status this document defines must appear in the manual. The
defect that motivates it is real — `/grill`'s prose documented four widgets for as long as
there were five, and nothing was checking.

This repo still proves the checker itself against fixtures it owns
(`test/fixtures/prose-check-good.md` / `-drifted.md` for the backtick convention,
`-good-fenced.md` / `-drifted-fenced.md` for the fenced-object-key one, run by
`test/check-prose-check.mjs`), because a checker with one real subject is still a checker
that has to fail in both directions.

**Ships from `src/`, not `test/`.** A caller outside this repo that *does* make a protocol
claim of its own can still bind it — `/example` names the `choose-between-rendered-variants`
widget and is the widget's only caller. A test helper reaching across the repo boundary
would be a coupling defect; a module this repo ships and its consumers import is a normal
library. But that path is now the exception rather than the shape every caller takes, and
the cheapest version of it imports nothing: `/example`'s own `check.mjs` asserts its widget
against the **installed manual** at `~/.claude/skills/claude-board/SKILL.md`, which the
absence check above guarantees is complete. Reading a file beats resolving a repo.

**API** (all named exports of `src/prose-check.mjs`):

```
checkProseFile(proseFilePath, options?)   the one-call entry point: reads the file, spins up
                                           a throwaway daemon + shim (never a real install),
                                           gets the live tools/list, reads this same clone's
                                           own PROTOCOL.md, and returns
                                           { ok, failures, claims, schemaProps }
assertProseMatchesShim(path, options?)    same, but prints each assertion and throws one
                                           summary Error if anything failed — the one-liner
                                           for a caller's own check.mjs. The thrown Error's
                                           `.message` is the full readable summary (see
                                           formatFailures below), not just a count
formatFailures(failures)                  renders `result.failures` (an array of
                                           `{ name, message }`) as readable text — use this
                                           rather than printing the array directly, which
                                           renders `[object Object]`
checkProse({ proseText, tools, protocolText?, toolName?, minLength?, claimedArgNames? })
                                           the pure assertion battery, given text you already
                                           have (no process spawned) — what checkProseFile
                                           calls after it gathers those three things
getLiveTools({ mcpPath, env? })           spawn a shim binary, initialize + tools/list,
                                           return the live tools array
parseBlockShapes(protocolText)            { blockKinds, widgets } off PROTOCOL.md's own
                                           "### Blocks" section
parsePacketStatuses(protocolText)         every status the Packet can carry, off PROTOCOL.md's
                                           own `status,` line
extractClaims(proseText, toolName?)       { blockKinds, widgets, args } auto-detected from the
                                           prose's own worked examples (`kind: '...'`,
                                           `widget: '...'`, and a "`tool` with `{ a, b }`"
                                           sentence for the argument list)
extractFencedCode(proseText)              every fenced code block's contents, concatenated —
                                           what the object-key argument convention is scoped to
argumentNamedInProse(proseText, argName, fencedCode?)
                                           true when argName is backticked anywhere, or an
                                           object key (explicit or ES6 shorthand) inside a
                                           fenced code block
resolveInstalledRoot(opts?)               the resolution story below, callable directly
loadInstalledChecker(opts?)               resolve + dynamically import, or null — see below
```

**Resolution story: how a caller outside this repo finds this file.** Kept, but no longer the
recommended path — see the two cheaper options first. The module cannot be
imported by a hardcoded, user-specific absolute path baked into each caller — the clone can
live anywhere, and can move. `install.sh` already writes the one thing that durably names the
clone's location: the LaunchAgent plist at `~/Library/LaunchAgents/claude-board.plist`
(`CLAUDE_BOARD_LAUNCH_AGENTS_DIR` overrides the directory), whose `WorkingDirectory` key is
this clone's absolute root (`install.sh` step 2, "launchd plist"). That is the one source of
truth this checker reuses rather than inventing a second one — there is no repo-path file
anywhere under `~/.config/claude-board`, only the secret lives there.

**Reach for this last.** In order of cost: a caller that restates no protocol needs no check
at all, which is now every caller but one; a caller making a single vocabulary claim asserts
it against the installed manual, a plain file read (`/example`); and only a caller that needs
the full battery against a live shim pays for the bootstrap below. Four skills carried this
paste when four skills each carried their own copy of the protocol. None do now.

A caller *inside* this repo just imports `../src/prose-check.mjs` directly, same as any other
sibling module. A caller *outside* this repo cannot import this file to reach
`resolveInstalledRoot()`/`loadInstalledChecker()`, because finding this file is the problem
those functions solve — so the same handful of lines have to live once in the caller's own
`check.mjs`, copied from here (kept in sync with `resolveInstalledRoot`/`loadInstalledChecker`
in `src/prose-check.mjs` — if one changes, change the other):

```js
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Degrade, not explode: a machine with no claude-board installed gets `null`, never a
 * thrown error, so a skill's own check suite can skip this one check and keep going. */
async function loadClaudeBoardChecker() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'claude-board.plist');
  let xml;
  try { xml = readFileSync(plistPath, 'utf8'); } catch { return null; }
  const m = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  const root = m && m[1].trim();
  if (!root) return null;
  const modulePath = path.join(root, 'src', 'prose-check.mjs');
  if (!existsSync(modulePath)) return null;
  try { return await import(pathToFileURL(modulePath).href); } catch { return null; }
}
```

Once pasted, using it is a one-liner:

```js
const checker = await loadClaudeBoardChecker();
if (!checker) { console.log('skip: claude-board not installed'); process.exit(0); }
await checker.assertProseMatchesShim(new URL('./SKILL.md', import.meta.url).pathname);
```
## Checks

`node test/run.mjs` runs every `test/check-*.mjs` — among them `check-pure`, `check-http`,
`check-mcp`, `check-install`, `check-prose-check` and `check-skill-prose` — and each is also
runnable alone. The count is deliberately not written down here; it was "five" for long
enough to go stale twice. No browser, no
network, no writes outside a temp `CLAUDE_BOARD_HOME`. Every check that touches the local
secret points `CLAUDE_BOARD_SECRET_FILE` at its own temp dir first: the real
`~/.config/claude-board/secret` is never read, written, or rotated by a check run.
