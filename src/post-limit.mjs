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

/** The most one pasted image may be, decoded, and the most all of one Send's images may
 * come to. The page refuses past these before sending; the daemon refuses past them too,
 * with a 400 naming the limit (src/images.mjs). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SEND_IMAGE_BYTES = 20 * 1024 * 1024;

/** 'bytes' in megabytes of 1024 * 1024 bytes, to one decimal and a whole number bare
 * ('10 MB', '10.5 MB'): how the page's paste hint and refusals and the daemon's 400s name
 * an image limit. Spliced by its source into the page's script (src/ui.mjs), so it is
 * written as the page's own code is. */
export function megabytes(bytes) {
  return String(Math.round(bytes / (1024 * 1024) * 10) / 10) + ' MB';
}

/** The submit route's body cap: one post's worth of text plus a Send's images as base64,
 * which carries 4 bytes for every 3. */
export const MAX_SUBMIT_BYTES = MAX_POST_BYTES + Math.ceil(MAX_SEND_IMAGE_BYTES * 4 / 3);
