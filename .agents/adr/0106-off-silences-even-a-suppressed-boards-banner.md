# 106. Off silences even a Suppressed board's Banner

2026-08-14 · narrows 92

**Context:** the four-step Banner level replaces the binary notifyRounds toggle, whose off still let a Suppressed board's first-round Banner through — the tab-for-banner trade of 91. **Decision:** that bypass survives at every On level, and Off alone is absolute silence. **Consequences:** a machine migrated from notifyRounds=false loses the one Banner it still got; the Popover's Waiting list is what remains.
