---
name: claude-board
description: One browser page for a round of questions or an artifact to react to, and the work's status beside it. Read before asking the user any question, showing a mock or diagram, recording a mission's status, or when a skill names the board.
---

<!-- Copied by install.sh from the clone's skills/claude-board/SKILL.md; edit it there, since a reinstall overwrites this copy. -->

# claude-board

A board is a browser page carrying a round of questions with their context beside them. The reviewer answers in any order, comments on a rendered stage or diagram by clicking it, and submits once.

## The call

`ask`, on the `claude-board` MCP server (`mcp__claude-board__ask` in Claude Code; Codex and OpenCode prefix it their own way):

```js
ask({ title, blocks, wait, fresh })
```

- `title`: `<work>: <this round>`, the work named the same way every round. Round 1's title names the board for good; the pager adds `Round N` itself.
- `blocks`: the ordered array the page shows. Each call posts one round to this conversation's board, which surfaces itself.
- **A round carries at most 6 questions or about 4,000 characters of prompts, explainers and options**, whichever comes first. Post a branch's questions together and split a branch too big for one round across rounds; only a question whose shape depends on an answer in this round waits for the next.
- `fresh` (default `false`) declares **you have posted no board in this conversation**. Pass it on your first `ask` whenever no board URL of yours is visible further up, and always after a `/clear`; never on later rounds, or each round gets its own board. It closes any open round on the board it leaves and names that board (`Abandoned board: <url>`) for `read`.
- `wait` (default `false`): a question round blocks until the reviewer submits, chooses Discuss, or the clock runs out (40 minutes by default); a content-only round returns once it lands. `wait: true` makes a page board round (below) block too and return its comments, possibly none, in this call's packet. It does nothing elsewhere.

**Say the board's URL in chat after every round.** A `/compact` rebuilds your context from the conversation, not from tool results, and a board you forget you have is abandoned by your next `ask`.

## Content blocks, by reference

```js
// lines is [from, to], 1-based inclusive; section is a heading slug; omit both for the whole file
{ kind: 'code',     source: { path: 'src/server.mjs', lines: [40, 72] } }
{ kind: 'markdown', source: { path: 'docs/notes.md', section: 'acceptance-criteria' } }
{ kind: 'mermaid',  source: { path: 'docs/flow.mmd' } }
{ kind: 'html',     source: { path: 'render.html' } }   // whole file only: lines/section are refused
{ kind: 'compare',  left: { label, block }, right: { label, block } }   // two content blocks, side by side
```

- The reference lives under `source` (a top-level path resolves to nothing) and is snapshotted at post time.
- **`section` is the heading's slug, not its text**: `## Open questions` is `section: 'open-questions'`.
- By value: `markdown` and `mermaid` may carry `text`, `html` may carry `html`, when no file backs it. `code` always needs a `source`. Otherwise reference the file.
- Anything judged by looking (a mock, a layout, a chart, a diagram, competing designs) goes up as `html` or `mermaid`; `markdown` and `code` carry what is read as text.
- A commentable block carries the comment control and the click-to-anchor gesture. Only the rendered kinds are — `mermaid` and `html` — and they are wherever they appear, including inside a question's `context` and inside a `compare` side. `markdown` and `code` are not, anywhere. The rule is drawn on kind, never on position, except a page board, which is commentable only when posted with `wait: true`.
- A reference resolves inside the board's project directory (relative or absolute) or a reference root: `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents` and `~/Documents/renders` by default. Any other directory needs adding to `CLAUDE_BOARD_REF_ROOTS` and a rerun of `install.sh`; until then its content goes up by value.
- **A post carrying a reference that fails to resolve is refused whole** with a 400 naming the project directory, the roots in force and the ways out; nothing is stored or shown.
- **Any block may carry card fields**, each left out when unused: `title` (the card's title line), `status: { label, tone }` (a verdict chip at the card's right edge, tone `'good'`, `'warn'`, `'bad'` or `'neutral'`), `summary` (one line of markdown under the title) and `details` (markdown folded closed, its fold named by `detailsLabel`, "Details" by default). Title each card, put a verdict in `status` and fold the supporting material into `details`. A question takes only `details` and `detailsLabel`: its prompt, answer state and explainer fill the rest.
- **A post or amend carrying a diagram that does not parse is refused**, whether a `mermaid` block or a `mermaid` fence in a `markdown` block, with the engine's first error line per diagram; a fence you cannot fix goes up by value, relabelled as code.

## Posting a rendered artifact

- **Write a generated stage into the render directory and reference it** by absolute path, `{ kind: 'html', source: { path: '/Users/you/Documents/renders/<file>.html' } }`, rather than pasting its bytes. Keep `html` by value for small, readable stages only.
- **A board whose blocks are one `html` block and nothing else is a page board**: the stage renders at viewport size instead of in the content column. Anything beside it silently costs it that layout, so post the artifact alone and ask about it in a later round.
- **An artifact is one self-contained file: every script, style, font and image inline or a `data:` URI.** A stage renders in a sandboxed opaque-origin frame, where a relative reference resolves against the board page's URL and silently never loads. One exception: a stage carrying a mermaid class marker gets the board's engine as `window.mermaid` before its scripts run, so it bundles none. Fonts, images and styles stay inline.
- **A video goes inline too**: `<video controls>` with a `data:` source, or a `blob:` URL the stage's own script builds from inlined bytes. An `http(s)` or relative source never loads. Write the `<video>` and its `aria-label` in the markup and have a script set only `src`, or every comment on the video is lost. A stage may carry up to the post's 25 MB, clips and images included; every other block keeps 512 KiB.
- **A stage sizes itself from its own content, never from the viewport**, so no `100vh` anywhere. Outside a page board the frame's height is derived from what the stage reports: it fits the artifact from 120px up to 600px; past that it folds, scrolling inside at 600px under a Show full height bar. A rendered-variant option clips at 600px with no bar.
- **A stage spans the board's column, which runs as wide as the window up to 2560px**: about 1810px at top level or in a question's context in a 1920px window, half that in a compare side. Lay a mock out to fill the width it gets, never at one fixed width.
- **Every diagram, and every stage outside a page board, carries a Pull-out** button about 36px square in its top-right corner, opening it at full viewport size: keep anything the reviewer must read or press out of that corner.
- An `http` or `https` link in a stage opens in a new tab at once; an in-page anchor brings its target into view.
- **Give each `<video>` an `aria-label` naming it.** A comment on a video carries the second it was paused at, as `anchor.time`, and reads like `"Criterion 2 clip at 0:07"`.
- **The board sets `data-theme` (`light` or `dark`) on the stage's document, and the stage sits on a light artboard in both themes.** A colorless stage reads in either. To follow the board, condition colors on `data-theme` and paint both halves: a dark palette sets its own background and `color-scheme: dark`, since light text on the artboard cannot be read. `prefers-color-scheme` always reads light inside a stage.

## Question blocks

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

- `single`: one choice. The recommended option goes first, labelled "(Recommended)", its reasoning in `description`.
- `multi`: whenever more than one option can be true. Always carry a None option ("None of these", labelled "(Recommended)" when it is): a multi with nothing ticked reads back as `unanswered`.
- `text`: free text, for genuinely open questions; the only widget with no options.
- `rank`: drag-to-rank, shown in your recommended order. It is answered by the order it shows, so Defer is the only way to leave it open.
- `choose-between-rendered-variants`: the reviewer clicks a rendered block. Each option carries `block` instead of `preview`; `choice` comes back as its `label`.

Two to four options read best, and every answer carries a free-text note. **Every option commits to an answer**: never offer a "your call" or "you decide" option, which leaves every recommended pick ambiguous between agreement and delegation.

`explainer` is one to three sentences of markdown under the prompt; `context` is what the reviewer looks up, one panel beside the options. **A question about a screen or control carries its mock in its own `context`, in the same round**, never a description or a pointer to an earlier round. Attach `code` only to a question about the code.

## What comes back

```js
{
  board, thread, title, round,
  status,                           // 'posted' | 'submitted' | 'discuss' | 'timeout' | 'abandoned' | 'error'
  answers:  [ { id, round, prompt, widget, status, choice, note } ],
  comments: [ { n, blockId, blockKind, anchor, text, round, createdAt, lost? } ],
  url,
}
```

- **`posted`**: nothing was asked, so `answers` and `comments` hold only owed entries (below).
- **`submitted`**: read every answer, then every comment.
- **`discuss`**: the reviewer chose Discuss. Post no more boards this session; pick the remaining branches up in chat, using the partial answers.
- **`timeout`**: no response, not a hang. Say so, then wait for the reviewer to reopen `url` or move on in chat. **Never silently retry the round.** A later `ask` opens a fresh round rather than amending the dead one. A late answer still reaches you (next packet, or `read`) and settles its question.
- **`abandoned`**: the board's conversation declared itself over (a `fresh` ask elsewhere) while you waited. No answer in it is a decision, but its comments count. A question that still stands goes to the *current* board, never into this one. A late Send there is stored, so `read` that board later if the question mattered.
- **`error`**: posted, but the wait did not complete, so nothing was answered. Report the message verbatim, name `url`, and stop: the board may already hold the round.

**Branch on each answer's `status`, never on `choice` being non-null:**

- `answered`: `choice` holds the answer.
- `deferred`: `choice` may hold a lean too. A lean is not a decision: track it as an open branch rather than re-asking now.
- `unanswered`: `choice` is `null`. A blank is a signal, not a default: say so, and decide with the reviewer whether to proceed without it or drop the branch.

A comment anchored to a block (`blockId`, `anchor`) is feedback on that block, not an answer; address it as its own input. One packet is one round: no packet redelivers earlier rounds.

**What no packet has carried is owed to the next packet the same thread returns, once**, tagged with its own `round`: comments on a page board posted without `wait` (or whose wait timed out), and answers sent after a round's wait ended. Any packet can carry them, `timeout` and `abandoned` included, so check `round` on every answer and comment before assuming it belongs to the round you just posted; the same check spots an entry `read` already showed you.

## Collecting a late answer

`read`, on the same server (`mcp__claude-board__read` in Claude Code), returns one board: every round, answer and comment on it, each naming its round. A round whose action reads `discuss` means what a `discuss` packet means. It only reads: nothing is marked delivered.

```js
read({ board })   // the URL an ask returned, or the bare board id
```

Call it whenever an answer may exist that no packet handed you:

- on the board an `ask` with `fresh` named in its `Abandoned board: <url>` line;
- after a `timeout` or `abandoned` round, once the reviewer has had time to come back;
- in a new conversation given only a board URL.

It works in a session with nobody watching; only a stopped daemon refuses it.

## When the board is unavailable

`ask` fails loudly and writes nothing, through `isError`, on three triggers: the board is unreachable, the session is headless, or the daemon cannot open a tab. Report the message verbatim, including any recovery command it names, say which trigger fired, then take your own path and say what it costs: off the board, questions lose multi-select, ranking, attached context and comment anchoring. A rendered artifact loses only its trip to the board: it is a file on disk, so `open` it and say where it is, because nothing else points at it.

## Every question goes to the board

Every question for the user goes through `ask`, a lone follow-up and a plain yes/no included: one question is a round of one. A host may refuse the in-chat question popup (`AskUserQuestion` in Claude Code) while the board is up, and the popup is the fallback only while the board is down, under "When the board is unavailable" above.

## Recording the work's status

When your work is a mission (`CLAUDE_MISSION` in your environment names its key, or your caller does), record its status through the `mission` tool on the same server (`mcp__claude-board__mission` in Claude Code), as it changes:

```js
mission({ action: 'write', key, fields: { phase, state, summary, waitingOn, next, prs } })
```

A mission holds work names, phases, links and closing summaries, never case content: nothing from the material the work handles goes in a field. `list` and `read` read missions back; `relay` and `ack` are the Master Chief's, never a working session's.
