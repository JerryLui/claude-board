# 36. An upgrade widens a carried-forward root record back to the current defaults

2026-08-07

**Context:** `install.sh` carries an existing `ref_roots` record forward, so this machine's record predated `~/Documents/renders` and every artifact a page board would show failed to resolve. **Decision:** an upgrade adds any directory the current defaults name that the carried-forward record is missing, and prints the line naming what it widened. **Consequences:** a read allowlist grows without being asked, so the print is load-bearing and a narrow list now needs `CLAUDE_BOARD_REF_ROOTS` set explicitly.
