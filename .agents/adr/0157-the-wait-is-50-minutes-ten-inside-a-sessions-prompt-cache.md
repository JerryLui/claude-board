# 157. The wait is 50 minutes, ten inside a session's prompt cache

2026-11-24, narrows 47; relates to 145, 151

**Context:** an answer later than 40 minutes after its round was posted reached a session that had given up, though a session's prompt cache lasts 60 minutes. **Decision:** the default wait is 50 minutes for every round shape, which leaves 10 of the cache; 47's one clock for every round and its countdown stand. The daemon, the board document and the shim read one constant, `DEFAULT_WAIT_TIMEOUT_MS` (src/handoff.mjs), and a check holds the launcher's compiled copy equal to it. **Consequences:** each pick, note or comment restarts the 50 minutes (145), so a round can still outlast the cache, and the session then pays for a cold one; the 24-hour ceiling on such a wait is unchanged.
