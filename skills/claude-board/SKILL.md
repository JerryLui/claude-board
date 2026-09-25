---
name: claude-board
description: One browser page for a round of questions or an artifact to react to. Read before asking the user more than one question, showing a mock or diagram, or when a skill names the board.
---

<!-- Installed by claude-board's install.sh from skills/claude-board/SKILL.md in the clone.
     Edits here are overwritten by the next install; change it in the clone instead. -->

# claude-board

A board is a browser page carrying a round of questions with their real context beside
them: rendered markdown, a diagram, a code excerpt, a comparison. The reviewer answers in
any order, comments on a rendered stage or diagram by clicking it, and submits once. You
supply references and question text; the board owns all markup and styling, and everything
you reference stays read-only.

## The call

`ask`, on the `claude-board` MCP server, takes four arguments, two of them optional. Claude
Code lists it as `mcp__claude-board__ask`; Codex and OpenCode prefix the same server and tool
name their own way, so find it under `claude-board` in the tool list:

```js
ask({ title, blocks, wait, fresh })
```

`title` names the round in its label and in the round pager, and round 1's title is the
board's for good: the tab, the page heading, the index row and the menu bar all show it, and
later rounds never rename it. Shape every title `<work>: <this round>`, the work named the
same way on every round and the round's own subject after the colon. The pager prefixes
`Round N` itself, so the title carries none. `blocks` is the ordered array the page shows.
One call is one round: the first surfaces the board, later calls push into the same board.
**A round carries at most 6 questions or about 4,000 characters of prompts, explainers and
options**, whichever comes first; past that the reviewer loses the thread. Within the cap, post
a branch's questions together, and split a branch too big for one round across rounds; only a
question whose *shape* depends on an answer in this round waits for the next one.

Surfacing it means a tab when no board tab is open anywhere, and otherwise a desktop
notification — a new tab is not thrown in front of a reviewer already reading a board. Either
way something tells them, and either way it is out of your hands.

`fresh` (boolean, default `false`) says **you have posted no board in this conversation**, so this
call starts a new board on a new thread and is surfaced as above. Pass it on your first `ask` of a
conversation whenever you cannot see a board URL of your own further up. After a `/clear` that is
always true — a cleared context holds no board — and it matters there: the board server keeps
running across a `/clear`, so without `fresh` your first question lands as another round on the
cleared conversation's board, under that work's title, and nothing surfaces it at all. Leave it off
for every later round, or each round gets a board of its own. It is harmless when there is nothing
to leave (one board, one thread), and it closes any round still open on the board it walks away
from, so nothing is left waiting there. The result names that board (`Abandoned board: <url>`),
because the reviewer may still answer it: `read`, below, is how you collect what they leave.

**Say the board's URL in chat after every round**, in your own reply, not only in what you post.
The packet's `url` is a tool result, and a `/compact` rebuilds your context from the conversation
rather than from tool results — so a board whose URL only ever lived in a tool result is a board
you will not know you have, and your next `ask` will declare a boundary that abandons work still
in progress.

`wait` (boolean, default `false`) blocks a page board round — the single-stage shape
described below — the same way a question round always blocks: the call returns only once
the reviewer submits, chooses Discuss, or the wall clock runs out, and whatever comments
they left on it come back in this call's own packet instead of riding a later round that
asks something. Every round blocks for at most 40 minutes by default, `wait: true` or
not. `wait` has no effect outside a page board round — a round carrying a question
blocks regardless of it, and any other content-only shape still posts and returns at
once.

## Content blocks, by reference

```js
// lines is [from, to], 1-based inclusive; section is a heading slug; omit both for the whole file
{ kind: 'code',     source: { path: 'src/server.mjs', lines: [40, 72] } }
{ kind: 'markdown', source: { path: 'docs/notes.md', section: 'acceptance-criteria' } }
{ kind: 'mermaid',  source: { path: 'docs/flow.mmd' } }
{ kind: 'html',     source: { path: 'render.html' } }   // whole file only: lines/section are refused
{ kind: 'compare',  left: { label, block }, right: { label, block } }   // two content blocks, side by side
```

The reference lives under `source`; path fields at the top level resolve to nothing. The
board snapshots the file at post time.

**A commentable block carries the comment control and the click-to-anchor gesture.**
Only the rendered kinds are — `mermaid` and `html` — and they are wherever
they appear, including inside a question's `context` and inside a `compare` side. `markdown`
and `code` are not, anywhere. The rule is drawn on kind, never on position — with one
exception: a page board (the single-stage shape described below) is commentable only when
posted with `wait: true`. Without it, the page is read-only — no comment control, no
click-to-anchor gesture, whatever kind its one block is.

**Pick the kind by how the reviewer takes the block in: anything judged by looking — a
mock, a layout, a chart, a diagram, competing designs — goes up rendered, as `html` or
`mermaid`; `markdown` and `code` carry what is read as text.** A mock sketched in markdown
or ASCII lands as prose — no comment control, nothing to click — and the reaction the
round exists for has nowhere to anchor.

**`section` is the heading's slug, not its text**: lowercase, spaces to hyphens, so
`## Open questions` is `section: 'open-questions'`. Get it wrong and the block resolves to
nothing.

`markdown` and `mermaid` may carry `text` by value and `html` may carry `html`, for a
hand-mocked stage or a note with no file behind it. `code` always needs a `source`.
Otherwise reference the file: generated bytes go stale, and no comment can anchor to a line
you paraphrased.

A reference resolves inside the board's project directory — relative or absolute, either
spelling — or a configured reference root (`~/.claude/skills`, `~/.claude/commands`,
`~/.claude/agents`, `~/Documents/renders` by default), and nowhere else: any other directory,
a workspace-root `SPEC_*.md` one level up for one, is reached by adding it to
`CLAUDE_BOARD_REF_ROOTS` and running `install.sh` again, and until then that file's content
goes up by value. **A post carrying a reference that fails to resolve is refused whole** — a
400 naming the project directory, the roots in force and those ways out, one message per
failed reference, nothing stored and nothing shown — so a bad path costs you a re-post rather
than costing the reviewer a broken page.

**A post or amend carrying a diagram that does not parse is refused** (ADR 117), whether
it is a `mermaid` block or a `mermaid` fence in a by-value or referenced `markdown` block. The
400 carries one message per failing diagram, naming its block id, question and context position, or
fence ordinal and referenced file, then the engine's first error line with its line number: fix
the source and post again; a fence you cannot fix goes up by value with its language changed so
it renders as code.

## Posting a rendered artifact

**Write a generated stage into the render directory and reference it**, rather than
pasting its bytes into the call: `{ kind: 'html', source: { path: '/Users/you/Documents/renders/<file>.html' } }`
costs one line for a byte-identical board, where
the same stage inlined as `html` runs to several KB per option. Keep `html` by value only
for stages small enough to read inline, and leave those readable: readability is the only
reason a stage is inline at all, so a stage you would be tempted to minify belongs in a
file you reference instead.

**A board whose blocks are one `html` block and nothing else is a page board**: that stage
renders at viewport size instead of in the content column. Nothing at the call site says
so — the shape of `blocks` is the whole declaration — so a stats line or a question posted
beside the artifact silently costs it the full-size layout and puts it back in the column.
Post the artifact alone and ask about it in a later round.

**An artifact is one self-contained file: every script, style, font and image inline or a
`data:` URI.** A stage renders in a sandboxed opaque-origin frame, and a relative
reference resolves against the board page's own URL, never the artifact's original
folder — so a sibling `assets/mermaid.min.js`, a linked stylesheet or an
`<img src="logo.png">` never loads, and the page arrives with that piece silently
missing. The renderer meets this contract before the post; nothing in the call can
repair a file that does not. One exception, mermaid: a stage whose bytes carry a
mermaid class marker gets the board's own vendored engine — `window.mermaid` exists
before the stage's scripts run, so an `if (!window.mermaid)` loader short-circuits
unmodified and an artifact needs no bundled engine. The exception is exactly that wide:
fonts, images and styles stay inline.

**Links inside a stage work, and the board owns them.** A click on an in-page anchor
(`href="#id"`) scrolls the stage to that element inside the frame, so a table of contents in
an artifact is worth writing. A click on an `http` or `https` link opens that address in a new
tab at once, from the board page and with no opener; a link of any other scheme does nothing at
all. The frame itself never navigates, so an outbound link is worth writing too.

**A stage sizes itself from its own content, never from the viewport.** Outside a page
board the frame's height is derived from what the stage reports, so a page laid out in
`vh` units reports whichever slice of itself happens to be visible and lands at the
placeholder height rather than its own. Size from the content — a `min-height` off what it
holds, no `100vh` anywhere — and the frame follows it.

**The board themes every stage.** Before a stage renders, the board sets `data-theme`
(`light` or `dark`) and `color-scheme` on its own document — a template that already reads
`data-theme` needs nothing new. Condition any literal color in your own CSS on that
attribute, in both directions, or leave the stage colorless and it inherits the board's
palette for free; a hardcoded light-mode color left unconditioned reads as broken the
moment the board is dark, and vice versa.

## Question blocks

A question carries its `prompt` by value, a `widget`, its own `context` array, and an
optional `explainer`:

```js
{
  kind: 'question',
  prompt: 'Which timeout does the wait route need?',
  explainer: 'The route holds one HTTP connection open for the whole wait.',
  widget: 'single',
  options: [{ label: '40m (Recommended)', description: 'matches the wall-clock cap' }, { label: '2h' }],
  context: [{ kind: 'code', source: { path: 'src/server.mjs', lines: [40, 72] } }]
}
```

- `single`: one of enumerated options. Recommended option first, labelled "(Recommended)",
  reasoning in its `description`, so the best case is confirming a good default.
- `multi`: whenever more than one option can be true. Always carry a None option — "None of
  these", labelled "(Recommended)" when it is — because a multi with nothing ticked reads back
  as `unanswered`, which is a blank, not an answer of none.
- `text`: free text, first-class. Use it for genuinely open questions rather than degrading
  them into false multiple choice. The only widget that needs no options.
- `rank`: drag-to-rank, for "in what order should these happen." Recommended order first: a
  rank question is answered by the order it shows, so a reviewer who agrees with that order
  sends it untouched, and Defer is the one way to leave it open.
- `choose-between-rendered-variants`: the reviewer picks by clicking a rendered block. Each
  option carries `block` instead of `preview`; `choice` still comes back as its `label`.

Two to four options reads best, and every answer carries a free-text note beside its
choice. A widget outside that list, or empty `options` on any widget but `text`, is a 400.

**Every option commits to an answer.** Picking the recommended one is already how the reviewer
accepts your judgment, so never offer a "your call" or "you decide" option: it leaves every
recommended pick ambiguous between agreement and delegation.

**The `explainer` goes under the prompt; `context` is what the reviewer looks up.** An
explainer is one to three sentences of markdown by value, rendered as plain prose across the
card's full row, with the options and the context panel side by side beneath it. `context`
renders as one panel — every item in the order you posted it, no card and no kind label around
each — beside the options, or full width under the prompt when the question carries a mock or
rendered variants. A markdown item longer than about a dozen lines folds under a Show more
control; a code excerpt keeps its own scroll box, and a diagram or a mock never folds.

**A question about a screen or control carries its mock in its own `context`, in the same
round**, never a description or a pointer to an earlier round: the reviewer judges what they
can see.
For a question about something rendered — `choose-between-rendered-variants`, or any
question whose `context` holds a mock or a diagram — skip the code excerpt: the rendered
stage is the thing being judged, and it lays out full width for exactly that reason. Reach
for `markdown` in `context` and save `code` for a question genuinely about the code.

## What comes back

A round carrying a question blocks until the reviewer submits or the wall clock runs out; a
round of content only returns the instant it lands.

```js
{
  board, thread, title, round,
  status,                           // 'posted' | 'submitted' | 'discuss' | 'timeout' | 'abandoned' | 'error'
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, lost? } ],
  url,
}
```

- **`posted`**: nothing was asked in this round, so `answers` and `comments` are empty unless
  the thread was owed something no packet had carried: an answer sent after an earlier round's
  wait ended, a comment left on a page board nobody waited on. A content-only round drains what
  is owed into its own packet, once, each entry naming the round it came from.
- **`submitted`**: read every answer, then every comment.
- **`discuss`**: the reviewer chose Discuss in chat. Post no more boards this session and
  pick the remaining branches up in chat, using the partial answers.
- **`timeout`**: an explicit no-response, not a hang. Say so, then either wait for the
  reviewer to reopen `url` or move on in chat. **Never silently retry the round.** A later
  `ask` on this board opens a fresh round with a live deadline rather than amending the dead
  one, so a question you ask again is asked on a round somebody is waiting on. A reviewer who
  answers the dead round late still reaches you, two ways: those answers arrive on your next
  packet the same way comments already do, appended to `answers` and each naming the round it
  belongs to, and `read` returns them at any time. Read every entry's own `round`, and treat a
  late answer as settling that question rather than re-asking it.
- **`abandoned`**: the round was closed while you were still waiting on it, because the
  conversation that owned the board declared itself over — a later `ask` with `fresh: true`
  started a new board, or the board was abandoned directly. Nobody had answered when it
  closed: it is not a timeout and not a submit, and no answer in the packet is a decision. Read
  any comments (they were left before it closed and still count), then post to the *current*
  board if the question stands. No wait ever returns to this round, so never re-post into it.
  The reviewer's Send still works on an abandoned question round, though, and what they send is
  stored, so `read` that board later when the question mattered.
- **`error`**: posted, but the wait did not complete, so nothing was answered and nothing
  about intent can be inferred. Report the message verbatim, name `url`, and stop rather
  than re-posting into a board that may already hold the round.

**Branch on each answer's `status`, never on `choice` being non-null:**

- `answered`: `choice` holds the answer.
- `deferred`: `choice` may hold a selection *too*. A lean is not a decision, so track it as
  an open branch rather than re-asking now.
- `unanswered`: `choice` is `null`. Blank is a signal, not a default. Say so, and decide
  with the reviewer whether to proceed without it or drop the branch.

A comment anchored to a block (`blockId` / `anchor`) is feedback on that block, not an
answer; address it as its own input. One packet is one round: round 6 does not redeliver
rounds 1 through 5. A page board posted with `wait: true` gets its own comments back the
normal way, in its own packet, `status: 'submitted'` — an empty `comments` array there is
a real outcome, not an error.

There are exactly two exceptions, and they are the same rule: **what no packet has carried
is owed to the next packet the same thread returns, once**, appended to that packet's own
array and told apart by the `round` each entry carries. A page board posted *without*
`wait` is the first — nothing ever waits on it, so a comment left there rides the next
packet; collecting comments from one therefore costs either `wait: true` on it or a later
round that asks something, and a `wait: true` page board whose wait times out falls back to
exactly this. The second is a round answered after its wait died, above. Both ride whatever
packet comes next, `timeout` and `abandoned` included, so check the `round` on every answer
and every comment before assuming it belongs to the round you just posted. `read` below is
not a packet and drains nothing, so an answer it has already shown you can still ride a later
packet: the same `round` check is what tells you it is an answer you already have.

## Collecting a late answer

`read`, on the same server (`mcp__claude-board__read` in Claude Code), takes one argument, and
returns one board:

```js
read({ board })   // the URL an ask returned, or the bare board id
```

Back comes that board's rounds (number, title, status, the reviewer's own action, whether a wait
is still open, deadline) and every answer and comment stored on it, each naming its round. A round
whose action reads `discuss` means exactly what a `discuss` packet means: stop posting further
boards for the rest of this session and continue the conversation in chat. It reads only: nothing is
marked delivered, nothing is written, and the same call twice returns the same thing, so reading
a board can never be the reason an answer goes missing from a later packet.

Call it whenever an answer may exist that no packet has handed you:

- after an `ask` with `fresh`, on the board named in its `Abandoned board: <url>` line: the
  previous conversation's reviewer may have answered after you walked away;
- after a `timeout` or an `abandoned` round, once the reviewer has had time to come back;
- in a new conversation given nothing but a board URL.

It reads any board on this machine, including one from before the daemon kept track of what it
had delivered. What it cannot do is ask: a question that still stands goes on the *current*
board through `ask`. And because it shows a human nothing, only the first failure below can
refuse it: a daemon that is not running. A session with nobody watching is a legitimate caller
for collecting an answer already given.

## When the board is unavailable

`ask` fails loudly and writes nothing, reported through `isError`, on three triggers: the
board is unreachable, the session is headless, or the daemon cannot open a tab. Report the
message verbatim, including any recovery command it names, say which trigger fired, then
take your own path and say plainly what it costs. Degraded, not equivalent: off the board,
questions lose multi-select, ranking, attached context and comment anchoring, while a
rendered artifact loses only its trip to the board — it is a file on disk, so `open` it and
say where it is, because nothing else points at it.

## When not to use the board

`AskUserQuestion` fits exactly two cases: a lone follow-up with no siblings in its branch,
and a plain yes/no confirmation. Anything bigger, whether a branch producing more than one
question or a single question needing options, multi-select, ranking, free text or context
beside it, goes through `ask`.
