# 15. The daemon's own code is staged into the signed bundle

2026-08-04

**Context:** the trustworthy launcher of entries 13 and 14 still forked node against `bin/daemon.mjs` and `src/` sitting unsigned and user-writable in the clone, so an edit took effect under the granted identity. **Decision:** `install.sh` stages both into `Contents/Resources` before `codesign`, and a deterministic payload digest joins the stamp. **Consequences:** the clone becomes a build input, so a bare `kickstart` no longer picks up a source edit.
