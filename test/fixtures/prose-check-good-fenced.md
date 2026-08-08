---
name: prose-check-fixture-good-fenced
description: >
  Fixture used ONLY by claude-board's own self-test (test/check-prose-check.mjs) to prove
  src/prose-check.mjs recognises an argument named as an object key in a fenced worked
  example, not only backticked -- the convention /visualize, /explain and /gamify actually
  ship. Not a real skill or command; installs nowhere.
---

# Fixture: arguments named only as fenced object keys

This file never wraps its argument names in their own backticks anywhere. It documents the
call the way the three renderer skills actually do: a fenced worked example whose object keys
ARE the argument names, one written explicitly and one as an ES6 shorthand property (the
local variable holding the chosen title doubles as the key).

## Calling ask

The title was already chosen in an earlier step. Post through the local claude-board daemon's
`ask` tool, exactly like this:

```js
ask({
  title,                                     // the plain-words title chosen earlier
  blocks: [{ kind: 'html', html: '<the finished file, verbatim>' }],
  wait: false,                               // this call never blocks
})
```

That round carries no question block, so `ask` returns the instant the post lands. Handle
whatever it returns.
