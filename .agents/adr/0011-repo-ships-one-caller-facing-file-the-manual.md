# 11. The repo ships one caller-facing file: the manual

2026-08-04 · narrowed by 102

**Context:** six callers outside this repo each restated how to call `ask` — 148 lines, already drifted on widgets, recovery command and `html` refs. **Decision:** `skills/claude-board/SKILL.md` ships from here and `install.sh` copies it unconditionally. **Consequences:** entry 5's boundary weakens to "one file, and we authored it", and in exchange `test/check-skill-prose.mjs` binds prose to mechanism in the shim's own repo.
