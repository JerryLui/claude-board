---
name: prose-check-fixture-drifted
description: >
  Fixture used ONLY by claude-board's own self-test (test/check-prose-check.mjs) to prove
  src/prose-check.mjs actually FAILS on drifted prose. Not a real skill or command; installs
  nowhere. Deliberately wrong: do not copy this file's claims anywhere.
---

# Fixture: a drifted caller

Same shape as the good fixture, except its claims about the tool have drifted from what the
shim actually exposes — the exact failure mode this checker exists to catch.

## Calling ask

Call `ask` with `{ title, blocks, notes }` — `notes` is not a real argument the shim's live
schema declares; this line is the injected drift. `title` is the round's title. `blocks` is
the ordered array of content and question blocks for this round.

A worked example, carrying a second drift — a widget that does not exist:

```js
{ kind: 'code', source: { path: 'src/example.mjs', lines: [1, 10] } }
{ kind: 'question', prompt: 'Which one?', widget: 'checkbox', options: [{ label: 'A' }, { label: 'B' }] }
```

Handle whatever `ask` returns: read the packet's `status`, and each answer's own `status`.
