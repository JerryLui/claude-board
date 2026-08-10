# 70. A page references its script and styles, content-addressed and never rewritten

2026-08-10 · accepted

**Context:** every emitted page inlines `ui.mjs` and `styles.mjs`, so roughly 438 KB of byte-identical
payload is written per board — about 16 MB of an 18 MB `pages/` directory. The emitted script is
already a plain IIFE with no module syntax, so nothing but the inlining itself requires it to be
inline.

**Decision:** a page references both as sibling files named by the hash of their contents, written
before the page that names them and never rewritten or overwritten. The reference is a bare
filename, the one form that resolves identically from the served page and from an archive opened in
Finder; `script-src` and `style-src` gain `'self'`, and the daemon grows its first static route.

**Consequences:** an archive is now a file plus its folder rather than a single file that can be
mailed. Pages already on disk keep their inlined copies forever, since a written archive is never
rewritten — this reclaims nothing retroactively. Every future change to the shared payload leaves
its predecessor on disk, removed only when a prune finds no page still naming it.
