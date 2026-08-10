# 68. A session that must not start the timer marks itself

2026-08-10 · narrows 67

**Context:** two keepalive crons (`claude -p "Respond with hello"` at 05:00 and 10:00) fire the
session-start hook and start a work interval nobody is present for. Nothing in a `SessionStart`
payload distinguishes a `claude -p` run from a real one — `source` is `startup` for both — and
TTY detection cannot work either, because the payload arrives on the hook's stdin and its stdout
is captured as `additionalContext`, so both are pipes in an interactive session too.

**Decision:** the caller declares itself. A session that must not touch the timer sets
`CLAUDE_BOARD_NO_POMODORO`, and the documented hook snippet exits early when it sees it.

**Consequences:** rejected inferring presence from a connected SSE client, which would have
needed no configuration but would silently refuse to start the timer whenever no board tab
happened to be open. The declaration lives in the user's crontab and `~/.claude/settings.json`,
outside what `install.sh` will touch, so it is applied by hand — but INSTALL.md's snippet is
extracted and executed by `test/check-install-doc.mjs`, so the guard itself is covered.
