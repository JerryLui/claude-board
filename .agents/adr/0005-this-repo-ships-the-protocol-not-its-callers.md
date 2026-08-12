# 5. This repo ships the protocol, not its callers

2026-07-31 · narrowed by 102

**Context:** `install.sh` shipped `commands/grill.md` from when `/grill` was the only caller, and five more callers then appeared that this repo never wrote. **Decision:** the repo ships the daemon, the shim, the protocol and the prose checker, and no callers. **Consequences:** callers stop tracking this repo's release cycle but now import a path inside it.
