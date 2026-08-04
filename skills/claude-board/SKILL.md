---
name: claude-board
description: How to use the local claude-board daemon's `ask` tool — the call shape, block kinds, widgets, the packet that comes back, and what to do when the board is unavailable. Use when a skill or command posts questions or a rendered artifact to the board, or names the board as where its questions go.
---

<!-- Installed by claude-board's install.sh from skills/claude-board/SKILL.md in the clone.
     Edits here are overwritten by the next install; change it in the clone instead. -->

# claude-board

A board is a browser page carrying a round of questions with their real context beside them:
rendered markdown, a diagram, a code excerpt, a side-by-side comparison. The reviewer answers
in any order, comments on any element by clicking it, and submits once.

Division of labor: you supply references and question text, the board decides how it looks.
Pass content by reference and let the renderer own all markup and styling. Everything you
reference stays read-only.

## The call

`mcp__claude-board__ask` takes exactly two arguments, and nothing else:

```js
ask({ title, blocks })
```

`title` names the round in the tab and the history rail. `blocks` is the ordered array of
what the page shows: content blocks, and the `kind: 'question'` blocks they support.

One call is one round. The first `ask` of a session opens a tab; later calls push into the
same board. Post a whole round in one call — a branch's questions belong together, and a
question whose *shape* depends on an answer in this round waits for the next one.

## Content blocks, by reference

Six kinds: `markdown`, `code`, `mermaid`, `html`, `compare`, `question`. A content block
names a file instead of carrying its bytes:

```js
// lines is [from, to], 1-based inclusive; section is a heading slug; omit both for the whole file
{ kind: 'code',     source: { path: 'src/server.mjs', lines: [40, 72] } }
{ kind: 'markdown', source: { path: 'SPEC_AUTH.md', section: 'acceptance-criteria' } }
{ kind: 'mermaid',  source: { path: 'docs/flow.mmd' } }
{ kind: 'html',     source: { path: 'render.html' } }
```

The reference lives under the `source` key. A block carrying the path fields directly
resolves to nothing. The board snapshots the file at post time.

**`section` is the heading's slug, never its text** — lowercase, spaces to hyphens, exactly
what `src/resolve.mjs` computes and compares against verbatim. `## Open questions` is
`section: 'open-questions'`. Get it wrong and the block resolves to nothing while the post
still returns 200.

**An `html` reference is whole-file only.** `lines` or `section` on one is refused: slicing
markup at a line boundary yields unclosed tags. Use a reference for a page you rendered to
disk rather than re-emitting its bytes as generated tokens.

**`markdown`, `mermaid` and `html` may carry content by value instead** — `text` for the
first two, `html` for the third — for a hand-mocked stage, a diagram with no file behind
it, or a short note that exists only for this board. `code` is the one kind that always
needs a `source`: a code block on a board is an excerpt of something real.

Prefer a reference when a file exists. By-value content is bytes you generate, it goes
stale the moment the file changes, and the board cannot anchor a comment to a line you
paraphrased.

A reference resolves inside the board's project directory or a configured reference root
(`~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents` by default), and nowhere else.
A reference that cannot be resolved does not fail the post: the block still lands, carrying
a visible `error` naming the reason. Check the packet's blocks if a board looks empty.

## Question blocks

A question carries its `prompt` by value, a `widget`, and its own `context` array, so the
question and the material it needs post together:

```js
{
  kind: 'question',
  prompt: 'Which timeout does the wait route need?',
  widget: 'single',
  options: [{ label: '2h (Recommended)', description: 'matches the wall-clock cap' }, { label: '30m' }],
  context: [{ kind: 'code', source: { path: 'src/server.mjs', lines: [40, 72] } }]
}
```

Pick the widget the question actually has:

- `single` — one answer from enumerated options. Put the recommended option first, label it
  "(Recommended)", and give the reasoning in its `description`. The best case for the
  reviewer is confirming a good default.
- `multi` — "which of these apply." Use it whenever more than one option can be true.
- `text` — free text, first-class. Use it for genuinely open questions rather than degrading
  them into false multiple choice. The only widget that needs no options.
- `rank` — drag-to-rank, when the question is "in what order should these happen."
- `choose-between-rendered-variants` — the reviewer picks by clicking a rendered block
  rather than a label. Each option carries `block` (a content block of any kind) instead of
  `preview`; `choice` still comes back as the picked option's `label`.

Two to four options reads best. Every answer carries a free-text note field beside its
choice automatically. A widget outside that list, or an empty `options` on any widget but
`text`, is a 400 rather than a silent fallback.

## What comes back

A round carrying any question block blocks until the reviewer submits or the wall clock runs
out. A round of content blocks only returns the instant the post lands. The packet's
`status` is one of:

- **`posted`** — nothing was asked, so there is nothing to wait for and nothing to report
  back from the round itself.
- **`submitted`** — read every answer, then every comment.
- **`discuss`** — the reviewer chose Discuss in chat. Stop posting boards for the rest of
  the session and pick the remaining branches up in chat, using the partial answers.
- **`timeout`** — an explicit no-response, not a hang. Say so, and either wait for the
  reviewer to reopen the board URL the packet names or move on in chat. Never silently retry
  the round.
- **`error`** — posted, but the wait did not complete: nothing was answered and nothing
  about the reviewer's intent can be inferred. Report the message verbatim, name the board
  URL the packet carries, and stop rather than re-posting into a board that may already hold
  the round.

**Branch on each answer's `status`, never on `choice` being non-null.** The two do not agree:

- `answered` — `choice` holds the answer.
- `deferred` — `choice` may hold a selection *too*. The reviewer can lean toward an option
  and still mark it revisit-later. Track it as an open branch instead of re-asking now, and
  never record that lean as a decision.
- `unanswered` — `choice` is `null`. The reviewer left it blank, which is a signal, not a
  default. Say so, and decide with them whether to proceed without it or drop the branch.

**Comments are not answers.** A comment anchored to a block (`blockId` / `anchor`) is
feedback on that block — the diagram, the code, the spec section. Address it as its own
input rather than folding it into a choice.

One packet is one round. Round 6 does not redeliver rounds 1 through 5.

## When the board is unavailable

`ask` fails loudly and writes nothing on three triggers, reported through `isError`: the
board is unreachable, the session is headless, or the daemon cannot open a tab.

Report the message verbatim, including any recovery command it names, and say which trigger
fired. Then take your own non-board path and say plainly what it costs. **Degraded, not
equivalent** — a fallback promises a path exists, never the same experience. Off the board,
questions lose multi-select, ranking, attached context and comment anchoring; a rendered
artifact loses only its trip to the board, since the file is already on disk.

## When not to use the board

`AskUserQuestion` is right for exactly two cases: a lone follow-up with no siblings in its
branch, and a plain yes/no confirmation. Opening a browser tab for one question is worse
than answering it inline. Anything bigger — a branch producing more than one question, or a
single question needing options, multi-select, ranking, free text, or context beside it —
goes through `ask`.
