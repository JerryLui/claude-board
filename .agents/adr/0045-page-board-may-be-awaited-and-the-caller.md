# 45. A page board may be awaited, and the caller declares it

2026-08-07 · narrows 35 and 44; completed by 50

**Context:** why the caller declares it rather than `blocks` implying it, and why not wait on every page board: DESIGN.md. **Decision:** `ask` takes `wait`, default false; a page board posted with `wait: true` blocks as a question round does, carries Send and Discuss, and returns its comments in its own packet. **Consequences:** `blocks` still decides layout and `wait` only decides whether anyone is listening, and *awaited* becomes the single property behind sendability, the index badge and the notification.
