# 40. A board header condenses into a centred pill on reading

2026-08-07 · narrowed by 59

**Context:** why no control on the header, and why the ramp replaced a boolean flipped at 24px: DESIGN.md. **Decision:** scroll offset becomes a 0-to-1 progress across 140px (`--stage-p` on `<body>`), insetting a centred band behind a header that stays full-bleed. Every board condenses this way, keeping the expanded header's control order (mark, comment toggle, theme, state label), and the pill's slot carries a label rather than a count — the countdown while the round is awaited, the bare word `read-only` the moment it is not. **Consequences:** the frame stays a constant viewport height and an ordinary board must reserve the header's flow box, so condensing can never reflow a document mid-read; the stage agent gains a scroll message, shape-checked like every other on that channel; and the slot's contract is "whatever names this page's state" rather than a number and a noun.
