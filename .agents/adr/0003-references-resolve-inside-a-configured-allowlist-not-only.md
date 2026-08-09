# 3. References resolve inside a configured allowlist, not only `cwd`

2026-07-30

**Context:** confining every reference to the board's `cwd` meant a session could never render the skill or command file it was discussing. **Decision:** references resolve under `cwd` or `CLAUDE_BOARD_REF_ROOTS`, defaulted in `install.sh` so that running the installer is the consent event. **Consequences:** widens the corpus reachable by anyone holding the session cookie, and a hard link into a root stays undefended by design (SECURITY.md).
