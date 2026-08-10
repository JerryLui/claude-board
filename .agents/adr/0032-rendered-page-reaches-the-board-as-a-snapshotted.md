# 32. A rendered page reaches the board as a snapshotted stage, not a framed served file

2026-08-07

**Context:** why a linked-out page was not left as it was, and why the daemon's own origin is never framed: DESIGN.md. **Decision:** the page is the existing `html` stage unboxed — bytes snapshotted at post time into the same opaque-origin `srcdoc` frame, laid out at viewport size. **Consequences:** an opaque origin resolves no relative subresource, so the artifact's CDN fallback must name the version the board CSP names, and 45-80 KB of markup lands in the board store per artifact.
