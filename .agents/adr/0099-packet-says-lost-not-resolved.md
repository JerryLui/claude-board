# 99. The packet says `lost`, not `resolved`

2026-08-11 · relates to 28

**Context:** the packet's `resolved` meant "the anchor still resolves", but a comment field
named resolved reads as review state to every consumer, and the boolean is redundant —
false exactly when `lost` is present. **Decision:** the MCP packet's comments drop
`resolved` and keep `lost` alone; the browser client's own comment shape and the page's
anchor-survival rendering are out of this decision's scope and may keep or flip it as
implementation detail. **Consequences:** PROTOCOL.md, the shipped SKILL.md and the anchor
checks change together, and any packet consumer branching on `resolved` branches on `lost`
instead.
