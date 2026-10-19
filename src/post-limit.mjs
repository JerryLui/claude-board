// The bytes one request body may carry, shared by the daemon (src/server.mjs's
// `readJsonBody`) and the MCP shim (bin/mcp.mjs's `httpJson`). Its own module because the
// shim imports it, and importing src/server.mjs would load the whole daemon into it.

/** The most one request body may carry, a board post above all. src/resolve.mjs's
 * `MAX_HTML_BYTES` is the same number by ADR 121 and a different bound: it caps one
 * stage's markup however it arrived, read off disk included, and this caps the bytes on
 * the wire. */
export const MAX_POST_BYTES = 25_000_000;

/** Past this many bytes a body is no longer read through to its 413: the daemon cuts the
 * connection instead, as an abuse bound, and the shim refuses to send such a body at all,
 * since a cut connection reads to it as a daemon to revive. */
export const MAX_DRAINED_BYTES = 4 * MAX_POST_BYTES;

/** What a board post of `bytes` over MAX_POST_BYTES is told, by the daemon's 413 and by
 * the shim's refusal alike. */
export function postTooLargeMessage(bytes) {
  return `post is ${bytes.toLocaleString('en-US')} bytes, over the ${MAX_POST_BYTES.toLocaleString('en-US')}-byte limit of one post: ` +
    'split it into rounds, or name a large stage\'s file in its source rather than inlining it';
}
