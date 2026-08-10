# 69. A conversation boundary is declared by the agent, and starts a new thread

2026-08-10 · narrows 4

**Context:** the shim survives `/clear` — Claude Code does not restart stdio MCP servers — so
`session.boardId` outlives the conversation that minted it and the next `ask` pushes a round onto a
board belonging to a conversation that no longer exists. No session id reaches the shim, by env var,
by `initialize` handshake or otherwise, and a `SessionStart` hook can reach only the daemon, which
cannot tell two shims in one repo apart.

**Decision:** `ask` takes a `fresh` flag meaning "I have posted no board in this conversation"; the
shim clears `session.boardId` and `session.thread` on it, so the next post mints a new thread and
opens its tab. The agent's own context is the only place a conversation boundary is visible, so it
declares the boundary rather than anything inferring it.

**Consequences:** a shim process now owns one thread per conversation, not one thread — ADR 4 and
the **Thread** glossary entry are narrowed to match. Correctness rests on the agent passing the
flag; nothing can detect a missed one, and a `/compact` that loses the board URL produces a
spurious new thread.
