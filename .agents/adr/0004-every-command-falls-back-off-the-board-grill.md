# 4. Every command falls back off the board, `/grill` included

2026-07-31 · narrowed by 55

**Context:** the shim refused a non-interactive session by design, which made every migrated command unusable headless. **Decision:** every command carries a non-board path and announces taking it, on three triggers — the daemon is unreachable, the session is headless, or no tab opens. **Consequences:** a broken board can go unnoticed behind a degraded path that keeps working, and `/grill` alone loses its artifact.
