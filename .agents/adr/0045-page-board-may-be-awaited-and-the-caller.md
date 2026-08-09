# 45. A page board may be awaited, and the caller declares it

2026-08-07 · narrows 35; completed by 50

**Context:** entry 35 makes collecting a comment cost a round that asks something, and nothing in `blocks` can infer whether a caller wants to hear back. **Decision:** `ask` takes `wait`, default false; a page board posted with `wait: true` blocks as a question round does, carries Send and Discuss, and returns its comments in its own packet. **Consequences:** `blocks` still decides layout and `wait` only decides whether anyone is listening, and *awaited* becomes the single property behind sendability, the index badge and the notification. Why not wait on every page board: DESIGN.md.
