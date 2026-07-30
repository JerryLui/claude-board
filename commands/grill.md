---
description: Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. Writes ADR.md, the repo glossary, and (when the outcome outlives the session) the spec live as branches resolve.
argument-hint: "[plan or topic to grill]"
---

# Grill Me

Interview the user relentlessly about every aspect of their plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

The plan or topic to grill: $ARGUMENTS

## How It Works

Switch into interviewer mode:

1. **Read the plan**: understand what the user has described so far.
2. **Identify the decision tree**: map out every branch (architecture, data model, UX, edge cases, testing seams, scope boundaries, deployment, dependencies). Testing seams (where tests will observe behavior, and prior art to pattern-match) and out-of-scope are mandatory branches: a grill is not done until both are walked.
3. **Grill by dependency layer**: post one round carrying every branch that nothing unresolved gates, its questions grouped by branch, highest-impact unknowns first. Sequence only on a real dependency, meaning an answer that would change what the next question even is. Branches that merely sit near each other in the design are independent and belong in the same round. Rounds should track the depth of the decision graph, not the number of branches in it.
4. **Stress-test with concrete scenarios**: before marking a fuzzy branch resolved, invent specific edge-case scenarios that probe its boundaries ("what happens when X and Y collide?"). Vague agreement is not resolution.
5. **Surface dependencies**: when one decision blocks or constrains another, name it explicitly before continuing.
6. **Write as you go**: after each resolved branch, restate the decision so the user can confirm or correct, then update the living documents below immediately. Never batch writes to the end; a session that dies mid-grill must lose nothing.
7. **Stop when aligned**: once all branches are resolved, give a short in-chat recap of the key decisions. If a spec exists, finalize it (acceptance criteria numbered and checkable, stale Open Questions pruned) and report its absolute path so implementation can start in a fresh session (`/tickets` first in a workspace that tracks work, then `/direct` or `/implement`); otherwise the recap is the deliverable.

## Living Documents

When grilling **inside a project** (not free-floating brainstorming), maintain these three documents. Create each lazily, only when there is something to write, and update them the moment a branch resolves.

### SPEC_<DESCRIPTOR>.md (until the work ships)

Create only when the outcome outlives the conversation: implementation is expected to happen in a fresh session, or the scope is too big for this one. Contained sessions (config tweaks, doc edits, decisions executed right here) end with the in-chat recap only, no spec file. Judge this lazily at first-write time; if scope grows mid-grill, create it then and backfill the resolved decisions. When genuinely unsure, ask with a single yes/no through `AskUserQuestion`.

The same document `/spec` maintains; the grill authors it live so no separate spec step is needed afterwards. Read `~/.claude/commands/spec.md` for the filename convention, section structure, and ownership rules before the first write. The grill fills the contract only: everything above the divider. State sections don't exist yet; `/spec` and `/direct` take over the same file once implementation starts. In Decisions, link `ADR.md` entries instead of restating them.

### ADR.md (permanent)

Append an entry to `ADR.md` in the project root when a resolved branch passes **all three** tests; otherwise skip it, most decisions don't qualify:

1. **Hard to reverse**: changing your mind later costs something real.
2. **Surprising without context**: a future reader would wonder "why on earth did they do it this way?"
3. **A real trade-off**: genuine alternatives existed and one was picked for specific reasons.

```markdown
## <n>. <title> — <YYYY-MM-DD>
**Context:** what forced it. **Decision:** what we chose. **Consequences:** what it rules out / costs.
```

### CONTEXT.md (permanent, repo-scoped glossary)

One `CONTEXT.md` at the repo root, never per session. It is a glossary of the project's ubiquitous language and nothing else: no implementation details, no spec, no scratch pad. When a term is resolved during the grill, write it immediately:

```markdown
**Order**: A confirmed customer purchase awaiting fulfillment. _Avoid_: purchase, transaction
```

- Definitions are one or two sentences: what the term IS, not what it does. Pick one canonical term and list rejected synonyms under `_Avoid_`.
- Only concepts specific to this project's domain; general programming concepts don't belong.
- In monorepos where service domains diverge, group terms under per-service subheadings. Still one file.

While grilling: challenge language that conflicts with the glossary ("CONTEXT.md defines cancellation as X, but you seem to mean Y, which is it?") and propose a precise canonical term when the user's language is fuzzy or overloaded.

## Asking Questions: Rounds Through the Board

Questions go through the local claude-board daemon, not one at a time in the terminal. `/grill` never authors a template, inline styling, or any hand-written markup of its own — it supplies block references and question text through the board's `ask` tool and lets the board render them. That is the whole division of labor: the command decides what to ask and what to attach, the renderer decides how it looks.

**Ask in layer-sized rounds.** A round carries every currently unblocked branch: typically three to ten questions, grouped by branch under its own heading, posted together in a single call to `ask`. The old "one question per tool call" rule is gone, and so is "one branch per round": batching is the point, not a shortcut. Don't split one branch's questions across several `ask` calls, and don't include a question whose *shape* depends on an answer sitting in the same round.

**Call `ask` with `{ title, blocks }`** — those are the only two arguments the tool takes, nothing else. `title` is the round's title (the branch name works well). `blocks` is the ordered array for this round: content blocks giving context, followed by the `kind: 'question'` block(s) that context supports.

**Every question block carries `prompt` (the question text, by value) and a `widget`** — pick the shape the question actually has, don't force it into the wrong one:

- `single` — one answer from enumerated options. Lead with your recommended option first, labeled "(Recommended)", with your reasoning in its description. The best case for the user is confirming a good default.
- `multi` — "which of these apply." Use it whenever more than one option can be true; don't force a `single` choice on a question that isn't actually single-choice.
- `text` — free text, first-class. Use it for genuinely open questions instead of degrading them into false multiple choice — that compromise existed only because the terminal tool had no free-text widget. The board does.
- `rank` — drag-to-rank ordering, when the actual question is "in what order should these happen / be prioritized."

`options` (for `single` / `multi` / `rank`) take 2-4 choices, recommended one first. Every answer also carries a free-text note field beside its choice automatically — that's not something to ask for as a separate question.

**Context travels by reference, never by paraphrase.** Attach real content as `context` blocks (`markdown`, `mermaid`, `code`, `html`, `compare`). A reference block is `{ kind, source }`, where `source` is `{ path, section?, lines? }` — the reference lives under the `source` key, it is never spread onto the block itself. The board resolves and snapshots `source` at post time; a block that carries the path fields directly, with no `source`, resolves to nothing.

```js
// a code block, lines 40-72 of a file (lines is [from, to], 1-based inclusive)
{ kind: 'code', source: { path: 'src/server.mjs', lines: [40, 72] } }

// a markdown block, one section of a document, addressed by heading slug
{ kind: 'markdown', source: { path: 'SPEC_AUTH.md', section: 'acceptance-criteria' } }

// a mermaid block, the whole file
{ kind: 'mermaid', source: { path: 'docs/flow.mmd' } }
```

The one exception is the `html` stage kind, for a hand-mocked preview with no source file — that one goes by value, as `{ kind: 'html', html: '…' }`, because there is nothing to reference. If a question needs the code, the diagram, or the spec section to be answerable, attach it as a reference block beside the question. Never retype, summarize, or paraphrase that material into the prompt or a markdown block's text — the existing agent contract holds: supply references and question text, never draft the content being rendered, and stay read-only toward everything you read.

A question block puts its reference blocks in its own `context` array, so the question and the material it needs post together:

```js
{
  kind: 'question',
  prompt: 'Which timeout does the wait route need?',
  widget: 'single',
  options: [{ label: '2h (Recommended)', description: 'matches the wall-clock cap' }, { label: '30m' }],
  context: [{ kind: 'code', source: { path: 'src/server.mjs', lines: [40, 72] } }]
}
```

**`AskUserQuestion` survives for exactly two cases: a lone follow-up with no siblings in its branch, or a plain yes/no confirmation.** Opening a browser tab for one question is worse than answering it inline. Anything bigger than that — a branch producing more than one question, or a single question that isn't yes/no and needs options, multi-select, ranking, or free text — goes through `ask`, not `AskUserQuestion`.

## Handling What Comes Back

`ask` blocks until the round is answered (or the wall clock runs out) and returns a packet whose `status` is one of `submitted`, `discuss`, `timeout`, or `error` — handle all four, don't assume the happy path:

- **`submitted`** — read every answer. Each one carries its own per-question `status`:
  - `answered` — use its `choice` and `note`.
  - `unanswered` — an explicit signal that the reviewer left it blank, not a default and not something to silently re-ask in the same breath. Say so, and decide with the user whether to proceed without it, revisit it in a later round, or drop the branch.
  - `deferred` — the reviewer wants this revisited later, not now. Track it as a still-open branch instead of re-asking immediately.
  - Any `comments` anchored to a block (`blockId` / `anchor`) are feedback on that block specifically — the diagram, the code, the spec section it's attached to — not an answer to fold into a question's choice. Address them as their own input.
- **`discuss`** — the reviewer chose Discuss in chat. STOP posting further boards for the rest of this session; pick up the remaining branches in chat instead, using the partial answers already included in the packet.
- **`timeout`** — no response inside the wall-clock cap. This is an explicit no-response, not a hang: don't silently retry the same round. Say so, and either wait for the user to reopen the board URL the packet names or move the remaining branches into chat.
- **`error`** — the round was posted but the wait did not complete normally: the daemon went away mid-wait, or the collect failed. Nothing about the reviewer's intent can be inferred from it, so treat it exactly like `timeout` for the answers (nothing was answered) and like a failure for the flow: report the message verbatim, name the board URL the packet carries so the user can see the round that is still live, and stop the grill rather than re-posting the same round into a board that may already hold it.

**Fail loudly, don't fall back.** If the call itself errors — the daemon is unreachable, or a non-interactive session refused on its own before posting anything — report the message verbatim, including the revive command it names (`launchctl kickstart -k gui/$(id -u)/claude-board` as of this writing; always relay whatever the tool actually printed, don't quote this from memory if it ever differs), and stop the grill. There is no automatic fallback to the terminal for board-shaped rounds, not even for a single question that would otherwise qualify for `AskUserQuestion` — a feature that quietly downgrades is a feature that stays broken for a week.

## Rules

- **Facts are yours, decisions are the user's.** If a fact is discoverable in the environment (filesystem, code, git, docs), look it up instead of asking. Cross-reference the user's claims against the code; when they contradict, surface it ("the code cancels whole orders, but you said partial cancellation exists, which is right?"). Every decision goes to the user.
- **Never assume.** Ambiguity gets a question, not a guess.
- **Group by dependency, not by topic.** Independent branches share a round; a branch waits only on an answer that would change its own questions. Label each branch's block so answers stay attributable.
- **Push back.** If a decision seems risky or contradictory, say so.
- **No implementation.** This is for planning only. Don't write code. The living documents above are the only files you touch.
- **Be direct.** Skip pleasantries. Get to the point.
- **Track progress.** Keep a mental map of resolved vs. open branches so the user knows how much is left.
