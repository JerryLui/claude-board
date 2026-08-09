# 28. Only the rendered kinds can be commented on

2026-08-06 · supersedes the comment half of 26

**Context:** the rule was drawn first on wrapper versus content kinds, then narrowed by position in entry 26, but the reviewer comments on rendered output and never on prose or code. **Decision:** the comment button and click-to-anchor belong to `html` and `mermaid` wherever they appear, `markdown` and `code` carry neither anywhere, and position stops being part of the rule. **Consequences:** the heading, list-item and code-line anchor kinds are deleted with their checks and their `src/anchor.mjs` machinery, and an archived board carrying such a comment stops rendering it.
