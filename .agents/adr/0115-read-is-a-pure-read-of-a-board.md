# 115. `read` is a pure read of a board

2026-09-10 · relates to 35, 107, 114

**Context:** a stored late answer reached an agent only through the next packet a wait on the same thread returned, so agents posted empty "collecting" rounds that paid out only when they happened to carry a question, and a new conversation never received it at all. **Decision:** a second tool, `read`, returns a board's rounds with every stored answer and comment by URL or id, from any conversation, marking nothing; the route sits behind the local secret alone. **Consequences:** no credential can burn answers and boards from before 107 read like any other, at the cost that a later `ask` packet on the same thread may repeat what `read` returned, each entry naming its round; a `fresh` ask names the board it abandoned so the id survives.
