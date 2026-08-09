# 64. A diff row suppresses syntax colour

2026-08-09 · narrows 63

**Context:** entry 63's six hues measured against a conventional diff tint (α 0.12) fail WCAG on real rows — comments 3.96:1 on a dark addition, strings 4.12:1 on a light one — and sweeping the alpha put the ceiling where every token still passes at α≈0.045-0.06, a tint too faint to carry the add/remove signal on its own. **Decision:** inside a `diff` block, rows keep the conventional α 0.12 `--good`/`--critical` fill and syntax colour drops to `--code-ink`, with `--muted` italic comments. **Consequences:** a diff reads as a change rather than as code, the two colour systems never composite, and `.diff`/`.patch` join `langForPath`'s extension table so a referenced patch file resolves to this path with no new concept.
