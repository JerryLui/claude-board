# 98. The comment toggle follows commentability

2026-08-11 · widens 46

**Context:** the toggle rendered as page-global chrome on every live board (pinned by
`test/check-comment-mode.mjs`), so a round of only question/markdown/code blocks offered a
mode with nothing to anchor — clicking it just locked the answers behind a Notice.
**Decision:** the toggle renders only when the round on screen holds at least one
Commentable block, extending entry 46's rule that a gesture nobody can act on is not
offered. **Consequences:** the "page-global chrome" pin is rewritten to assert the gating,
and the toggle's presence is no longer constant across boards.
