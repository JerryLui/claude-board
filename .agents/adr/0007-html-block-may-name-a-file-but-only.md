# 7. An `html` block may name a file, but only a whole one

2026-08-04

**Context:** an 80 KB rendered page could reach a board only as ~25-30K generated tokens, a price an agent silently declined to pay, posting a stub instead. **Decision:** `html` accepts `source: { path }` through the same reader, confinement, cap and error behaviour as every other kind, refusing `lines` and `section` because markup does not survive slicing. **Consequences:** `html` becomes the only path-only ref, and a referenced file executes in the stage on exactly the footing an inline mock does (SECURITY.md).
