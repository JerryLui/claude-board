# 13. The daemon's environment is baked into the launcher, not the plist

2026-08-04

**Context:** the plist is mode 644 and user-writable, so a `NODE_OPTIONS=--require` key ran arbitrary code inside the TCC-granted process with the signature untouched. **Decision:** `bin/launcher.c` `execve`s an environment it constructs itself — five variables compiled in via `launcher_paths.h`, seven named ones passed through, and nothing else placed there at all. **Consequences:** retargeting a root now costs a rebuild, a re-sign and a TCC re-approval.
