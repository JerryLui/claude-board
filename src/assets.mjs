// The two payloads every emitted page used to carry a private copy of — the client
// script (src/ui.mjs) and the stylesheet (src/styles.mjs) — named by the hash of their
// own contents so a page can reference them instead of inlining them. ADR 70.
//
// This module answers only "what are the shared assets called, and what is in them".
// Where they live on disk is src/store.mjs (it owns `pages/`), how a page names them is
// src/render.mjs, and how the daemon hands one back is src/server.mjs's static route.
//
// Two rules make the reference safe, and they are the whole design:
//
//   1. The name is CONTENT-ADDRESSED. A page written today names the exact bytes it was
//      rendered against, forever: changing src/ui.mjs mints a new name and leaves the old
//      file untouched beside it, so no already-written archive is ever silently repointed
//      at a payload it was not built for. Never overwritten, never deleted here — a prune
//      is the only thing that may remove one, and only when no surviving page names it.
//   2. The reference is a BARE SIBLING FILENAME. Not a path, not a URL, not a leading
//      slash. That is the one form that resolves identically from a page served at
//      `/b/<id>` (→ `/b/<name>`, the daemon's static route) and from the same bytes
//      double-clicked in Finder (→ the file next to it in `pages/`). An archive is
//      therefore a file plus its folder rather than a single mailable file, which is the
//      cost ADR 70 accepted.
//
// The script is referenced as a CLASSIC deferred script, not `type="module"`, and that is
// load-bearing rather than stylistic: Chrome refuses a module script over `file:` outright
// (module fetches are CORS-gated and a `file:` document's origin is null), so a module
// reference would break the Finder surface — verified against real Chrome, both ways.
// `ui` is a plain IIFE with no static `import`/`export` and no `import.meta` (its one
// `import()` is dynamic, inside a function, which a classic script runs fine), so nothing
// in it ever needed module semantics; only the inlining did. `defer` keeps the execution
// timing a module tag already had — after parsing, before `DOMContentLoaded` — which two
// `document.readyState === 'complete'` branches in src/ui.mjs read.

import { createHash } from 'node:crypto';
import { ui } from './ui.mjs';
import { styles } from './styles.mjs';

/** 16 hex characters of SHA-256, i.e. 64 bits. Not a security boundary — these files are
 * written by this daemon from its own bundled source and read back by it, never accepted
 * from anywhere — so this is a collision budget, not a preimage one, and 64 bits against
 * the couple of dozen payloads a long-lived store accumulates is not a number that comes
 * up. Truncated because the name is read by humans listing `pages/`. */
function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The shared assets for a given pair of payloads, as `{ name, contents }`.
 *
 * Parameterised rather than hardcoded to the imported `ui`/`styles` for one reason: it is
 * the only honest way for a check to exercise "the shared payload changed" — the case the
 * whole content-addressing scheme exists for — without editing src/ui.mjs on disk mid-run.
 * Every caller in src/ uses `SHARED_ASSETS` below. */
export function sharedAssets(scriptText = ui, styleText = styles) {
  return [
    { name: `ui-${digest(scriptText)}.js`, contents: scriptText },
    { name: `styles-${digest(styleText)}.css`, contents: styleText },
  ];
}

export const SHARED_ASSETS = sharedAssets();
export const SCRIPT_ASSET = SHARED_ASSETS[0].name;
export const STYLE_ASSET = SHARED_ASSETS[1].name;

/** What an asset filename is allowed to be — anchored, so it admits no separator, no dot
 * segment and no NUL. Every path built from a name off the wire goes through this (the
 * static route hands `/b/<this>` straight to a `readFileSync` under `pages/`), exactly the
 * discipline src/store.mjs's `SAFE_BOARD_ID` already applies to board ids. It also keeps
 * the two namespaces disjoint by construction: an asset name contains a dot, so it can
 * never be a board id, and a board's page is `<id>.html`, so it can never be an asset. */
export const ASSET_NAME = /^(?:ui|styles)-[0-9a-f]{16}\.(?:js|css)$/;

/** Which assets does this page name? The question a prune has to answer for every
 * surviving page before it may delete anything, so the name shape above is deliberately
 * self-identifying: a scan of the page's bytes answers it, with no HTML parsing, no
 * attribute extraction and no coupling to how src/render.mjs happens to spell the tags.
 * Returns bare filenames, deduplicated — resolve them against the page's own directory. */
export function assetsNamedBy(pageText) {
  const found = String(pageText).match(/(?:ui|styles)-[0-9a-f]{16}\.(?:js|css)/g);
  return found ? [...new Set(found)] : [];
}

/** The `content-type` for a served asset. Derived from the name rather than tracked
 * alongside it, because the name is the only thing the static route is given. */
export function assetContentType(name) {
  return name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
}
