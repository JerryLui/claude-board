// A card's status chip tones (ADR 132), shared by the post check (src/board.mjs), the
// chip's render (src/render.mjs) and the MCP shim's tool schema (bin/mcp.mjs). Its own
// module because the shim imports it, and importing src/board.mjs would load the
// renderer into it.

export const STATUS_TONES = Object.freeze(['good', 'warn', 'bad', 'neutral']);
