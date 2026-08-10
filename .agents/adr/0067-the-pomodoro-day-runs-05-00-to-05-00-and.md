# 67. The pomodoro day runs 05:00 to 05:00, and its rollover ends the loop

2026-08-10 · narrows 8

**Context:** a paused timer was immortal — `settleBoundary` returns early on `paused`, so the
30s-grace expiry rule never reached it, and `startWork` no-ops against any non-null timer.
A timer paused on Monday was therefore still paused on Tuesday, and every session start
politely declined to touch it. Nothing in the code ever reset the timer on a date change;
`normalizeCycle` reset only the cycle counter, keyed to local midnight.

**Decision:** the day boundary is 05:00 local, for the cycle and the timer alike, and crossing
it clears both. It is observed lazily by whatever next touches the document — reads included —
rather than by a scheduled job.

**Consequences:** a session running past midnight keeps its cycle, which local midnight would
have wiped mid-stride. No second clock and no launchd entry to keep in sync with the daemon,
at the price of the rollover being invisible until something looks.
