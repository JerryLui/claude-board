// The vendored mermaid engine's own identity: its raw source and the
// content-addressed name it is served under (ADR 70's scheme, extended to a third
// shared asset). Both src/assets.mjs (which has to put it in SHARED_ASSETS, the
// list the daemon writes and serves) and src/ui.mjs (which has to splice the
// FILENAME into its own client script, so the browser knows what to fetch) need
// this same value -- and they import it from HERE rather than from each other,
// because assets.mjs already imports `ui` from ui.mjs (to hash it) and a
// ui.mjs -> assets.mjs import back would be circular: Node's live-binding model
// does not re-run a module already mid-evaluation, so whichever side asked
// second would read `ui` (or MERMAID_ASSET) before its own module finished
// initializing it -- a TDZ ReferenceError, not a stack overflow, and one that
// only shows up the moment something imports ui.mjs first (i.e. always). This
// module has no dependents that could cycle back, so both sides import the one
// true name from it instead.
//
// mermaid.min.js itself is not an ES module -- see its own upstream shape below
// -- so this file is also, like src/vendor/prism/index.mjs, a hand-written
// loader over vendored non-ESM source, not a re-export of one.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

/** The vendored engine's raw bytes, byte for byte what ships in
 * src/vendor/mermaid/mermaid.min.js -- digest-pinned by
 * test/fixtures/vendor-manifest.json like every other vendored file, and never
 * modified here, only read. Upstream's own single self-contained IIFE build
 * (`dist/mermaid.min.js`, not the ESM entry): zero dynamic `import()`s, so
 * vendoring this one file is the whole engine, no sibling chunk tree. */
export const MERMAID_SOURCE = readFileSync(new URL('./mermaid.min.js', import.meta.url), 'utf8');

/** 16 hex sha256 characters -- exactly src/assets.mjs's own private `digest()`,
 * kept as its own one-liner here rather than imported from there: importing it
 * would recreate the very cycle this module exists to avoid. */
function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The bare, content-addressed sibling filename this engine is served under --
 * same shape as SCRIPT_ASSET/STYLE_ASSET (src/assets.mjs), so `'self'` in the
 * board CSP already admits it on both surfaces with no extra allowlist entry. */
export const MERMAID_ASSET = `mermaid-${digest(MERMAID_SOURCE)}.js`;

/** Load the vendored engine into THIS PROCESS's real global object, the way a
 * classic `<script>` tag does -- proving, under plain Node with no browser and
 * no DOM, that the real vendored bytes actually execute and hand back the
 * documented shape, not just that they hash correctly (test/check-vendor-digest.mjs's
 * own reason for actually calling into marked/Prism, applied here).
 *
 * `vm.runInThisContext`, never a bare `import()`: mermaid.min.js is upstream's
 * classic-script build -- `var __esbuild_esm_mermaid_nm; (…).mermaid = (()=>{…})();
 * globalThis["mermaid"] = …` -- and that top-level `var` only reaches
 * `globalThis` under CLASSIC script semantics. An ES module's top-level `var`
 * stays module-scoped, so importing this file as a module sets a binding
 * nothing else can see and the final `globalThis.mermaid = …` line reads back
 * `undefined` (reproduced) -- the exact reason src/ui.mjs never uses `import()`
 * for it either (that file's own comment covers the second, independent reason:
 * a module fetch is CORS-gated over `file:` regardless of same-origin-ness, so
 * it would also break the Finder surface). `vm.runInThisContext` runs the
 * source with real top-level-script scoping against the real global object,
 * same as a `<script>` tag, without either problem. */
export function loadMermaidEngineForNode() {
  vm.runInThisContext(MERMAID_SOURCE, { filename: 'mermaid.min.js' });
  return globalThis.mermaid;
}
