---
name: prose-check-fixture-good
description: >
  Fixture used ONLY by claude-board's own self-test (test/check-prose-check.mjs) to prove
  src/prose-check.mjs against a prose file that matches the shim's real shape. Not a real
  skill or command; installs nowhere.
---

# Fixture: a well-formed caller

This file is shaped like a `SKILL.md` a migrated command might ship, so the shared checker
has something realistic to run against. Its instructions post through the local claude-board
daemon's `ask` tool, exactly as `commands/grill.md` does.

## Calling ask

Call `ask` with `{ title, blocks, wait, fresh }` — those are the arguments the tool takes,
`wait` and `fresh` optional. `title` is the round's title. `blocks` is the ordered array of
content and question blocks for this round. `wait` (default false) blocks on a page board
round the same way a question round does. `fresh` (default false) says this conversation has
posted no board yet, so the call starts a new one.

A worked example: a code reference block, followed by a single-choice question.

```js
{ kind: 'code', source: { path: 'src/example.mjs', lines: [1, 10] } }
{ kind: 'question', prompt: 'Which one?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }
```

Handle whatever `ask` returns: read the packet's `status`, and each answer's own `status`.
