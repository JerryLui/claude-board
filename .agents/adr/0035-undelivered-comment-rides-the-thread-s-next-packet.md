# 35. An undelivered comment rides the thread's next packet

2026-08-07 · narrowed by 45 and 46; widened by 107

**Context:** a page board asks nothing, so `ask` returns the instant it lands and the session is gone before the reviewer has read the artifact. **Decision:** a comment left on a board that returned no packet is held as undelivered and travels in the next packet the same thread returns, once. **Consequences:** collecting a comment costs a round that asks something, and a thread whose session ends before the reviewer comments strands it.
