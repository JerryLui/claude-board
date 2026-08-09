# 38. `/file/` is deleted; the board is the only way to see a rendered page

2026-08-07

**Context:** `GET /file/<path>` existed because markdown cannot link to `file://` — it streamed bytes out of a `CLAUDE_BOARD_SERVE_ROOTS` allowlist — and a page board embeds the artifact, so the route is now a second way to look at one thing. **Decision:** `handleServeFile`, `SERVE_CSP`, `SERVE_TYPES`, the `CLAUDE_BOARD_SERVE_ROOTS` allowlist and its install step and record file all go. **Consequences:** every already-archived board's link 404s, and an artifact is capped at one self-contained file, since an opaque origin resolves no relative URL.
