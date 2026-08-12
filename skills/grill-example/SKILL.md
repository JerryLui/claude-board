---
name: grill-example
description: Example skill. Relentless design interview that walks a plan's decision tree to resolution, posting each round of open branches to a board instead of asking them one at a time.
---

<!-- An example, not part of the install: install.sh copies only skills/claude-board/.
     Copy this directory into ~/.claude/skills/ to get /grill-example, then edit it. The
     part worth keeping is how a round of an interview maps onto a board post; the rest is
     one opinion about how to run a design review, and yours will differ. -->

# Grill me

Interview the user relentlessly about a plan until you reach a shared understanding, and
write nothing but planning documents until you have it.

Adapted from Matt Pocock's [`grill-me` and `grilling`
skills](https://github.com/mattpocock/skills/tree/main/skills/productivity), which run the
same interview in the terminal, one question at a time. This version changes only where the
questions go.

## The loop

Map the plan as a **design tree**: every decision branches into the decisions that hang off
it. The **frontier** is every branch whose prerequisites are already settled — everything
askable *now* without guessing at an answer you have not heard yet.

Work the tree in **rounds**. Ask the whole frontier, highest-impact unknowns first; hold a
question whose *shape* depends on an answer still open in this round for the next round.
When one decision constrains another, name the dependency out loud. Every answer reshapes
the tree: settled branches push the frontier outward, so recompute it and ask again. The
session ends when the frontier is empty — every branch visited, nothing silently assumed.

**Stress-test before resolving.** Invent edge cases that probe a fuzzy branch's boundaries
("what happens when X and Y collide?"). Vague agreement is not resolution. Push back when a
decision looks risky or contradictory, and do not act on the plan until the user confirms
the understanding is shared.

## A round is a board post

**Read the `claude-board` skill for the call, the block kinds, the widgets, the packet and
the fallback** — that skill is the protocol, and none of it is restated here. What a grill
adds on top:

- **A round is the frontier.** Title the post with the dominant branch name; three to ten
  questions in one call, grouped under it.
- **Every question carries your recommended answer and the reason for it**, whatever its
  shape — a ranking, a multi-select and an open text question each get one.
- **Attach what the decision rests on**, by reference: the plan section under discussion,
  the code it constrains, the diagram. A question answerable only by scrolling back through
  chat was posted without its context.
- **Show a visual choice, never describe it.** A branch the user could settle by looking —
  layout, arrangement, emphasis, wording — goes up as rendered variants rather than prose or
  a code snippet. That branch is its own round.
- A comment on a block is feedback on that artifact, not an answer to a question. A deferred
  answer is not an answer either: keep the branch open rather than re-asking it now.
- The reviewer choosing to discuss in chat ends the board for this session; pick the
  remaining branches up in chat. Board unavailable: keep grilling, falling back as the
  manual says.

**Facts are yours, decisions are the user's.** Anything discoverable in the environment
(filesystem, code, git, docs) you look up rather than ask about. Cross-reference the user's
claims against the code and surface contradictions ("the code cancels whole orders, but you
said partial cancellation exists, which is right?"). Every decision goes to the user, and
ambiguity gets a question rather than a guess.

## One question, worked

Test level is a mandatory branch — it stays on the frontier until walked — and it shows the
shape the rest should copy. One single-choice question, four options. Where the seams are,
what to mock, and which prior-art test file to pattern-match are *facts*: find them in the
repo yourself and put them in the recommended option's description. The user owns only how
far up the ladder this work goes, so recommend the rung the repo's prior art already sits at.

1. **None** — manual check, no test lands.
2. **Unit** — pure logic only, boundaries mocked. Fast, cheap, proves the least.
3. **Service-level** — real code paths against fakes and fixtures, no network. The default
   for most work.
4. **Full integration** — live dependencies, slow, and on a key-configured machine it spends
   real money.

On rung 3 or 4, "which fixtures, which live deps" is a lone follow-up in chat. The user has
no view into seams, so every testing question keeps this shape.

## Write as you go, stop when aligned

Each branch that resolves: restate the decision for confirmation, then fold it into the
planning document immediately — whatever this project keeps, a spec, a decision record, a
plan file. A session that dies mid-grill then loses nothing. When the frontier empties,
recap the key decisions in chat and say where the document is, so implementation starts from
it rather than from the transcript.
