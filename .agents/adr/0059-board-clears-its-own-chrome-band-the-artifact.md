# 59. The board clears its own chrome band, the artifact does not

2026-08-09 · narrows 40

**Context:** entry 40's floating header made every artifact responsible for ~96px of top padding, a number stated only as prose in `skills/claude-board/SKILL.md` against a header whose real height moves with the title's wrap and the viewport's width — so an artifact that padded nothing lost its own opening, silently, and nothing warned anyone. **Decision:** the parent reports its chrome band to the stage over the existing `stageAgentScript` channel and the stage tops its own `body` padding up to it, top and bottom, padding only and never a background. **Consequences:** the ~96px paragraph is deleted rather than corrected, an artifact that already pads keeps its own larger value, and the parent owes a fresh report on resize as well as at first paint.
