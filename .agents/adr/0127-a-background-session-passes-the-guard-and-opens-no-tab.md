# 127. A background session passes the guard and opens no tab

2026-10-28, widens 116

**Context:** the Master Chief starts each phase of a mission as a Claude Code background session, which nobody sits at and whose entrypoint is outside the guard's allowlist, so its first `ask` was refused; let through as it was, it would also open a tab on every round, taking focus from whatever the person was doing. **Decision:** `CLAUDE_BOARD_CLIENT=background` passes the guard as every declared client does (116), and with it `ask` opens no tab: the round's Banner and the Missions view announce it. `CLAUDE_BOARD_HEADLESS=1` still wins, and a `claude -p` run (entrypoint `sdk-cli`) without the flag is refused as before. **Consequences:** whoever sets the flag takes on 116's promise that a human answers that session's boards, so the Master Chief's launcher sets it and a nightly or scripted run must not; the flag is declared, never checked, the same residual gap `/loop` already is.
