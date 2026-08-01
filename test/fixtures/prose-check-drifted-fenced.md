---
name: prose-check-fixture-drifted-fenced
description: >
  Fixture used ONLY by claude-board's own self-test (test/check-prose-check.mjs) to prove
  the fenced-object-key argument detection still FAILS when a real argument never appears,
  not just when one is present -- the same both-directions requirement as the backtick
  fixtures. Not a real skill or command; installs nowhere. Deliberately wrong: do not copy
  this file's claims anywhere.
---

# Fixture: a fenced example missing a real argument

This file documents the call with a fenced worked example, exactly like the good-fenced
fixture, except its example omits one of the tool's two real arguments entirely -- not
backticked anywhere, not an object key anywhere, not named at all. That omission is the
injected drift this fixture exists to catch.

## Calling ask

Post through the local claude-board daemon's `ask` tool, like this:

```js
ask({
  title: 'Example dashboard',
})
```

Handle whatever `ask` returns.
