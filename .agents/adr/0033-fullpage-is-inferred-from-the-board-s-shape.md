# 33. Fullpage is inferred from the board's shape, not declared by the caller

2026-08-07

**Context:** a `display: 'page'` field would make it explicit, at the cost of protocol surface every caller has to remember, where entry 26's equivalent inference has held. **Decision:** a board whose blocks are one `html` block and nothing else renders as a page board; anything else renders exactly as a board does today. **Consequences:** the rule is invisible at the call site, so a caller that posts a stats line beside its artifact silently loses fullpage, which is why the renderer skills drop the stats line.
