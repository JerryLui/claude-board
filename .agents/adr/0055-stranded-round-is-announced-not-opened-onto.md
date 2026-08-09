# 55. A stranded round is announced, not opened onto

2026-08-09 · narrows 4; widened by 58

**Context:** everything that raises a signal for an awaited round is code inside the board tab, so a reviewer who closes that tab mid-wait is told nothing for the rest of the wait; the shim's one cover, forcing a tab open when the board reports no client, runs at post time only, steals focus, and fires on the false zero an SSE reconnect produces. **Decision:** the daemon raises a native banner when a round becomes stranded, evaluated at post and again when the last watcher leaves, after a short grace; the shim's forced reopen is deleted and the first board of a thread still opens as it always has. **Consequences:** the reviewer chooses when to come back rather than having a tab appear mid-sentence, at the price of the daemon owning a per-board timer and a disconnect hook it did not before, and of a signal that is silent where notifications are.
