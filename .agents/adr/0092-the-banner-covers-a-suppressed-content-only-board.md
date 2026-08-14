# 92. The Banner covers a Suppressed content-only board

2026-08-11 · widens 55; widens 91; narrowed by 106

**Context:** a page board posted without wait has nothing Awaited, so the stranded rule would never banner it, and a Suppressed one would land silently, reachable only through chat or the index. **Decision:** a Suppressed board's first round is Stranded even with nothing Awaited: one Banner, the same grace, the click opening the board. **Consequences:** Stranded no longer implies someone is waiting, and the click child's lifetime cannot come from a round deadline — there is none — so the fixed click-lifetime bound alone bounds it.
