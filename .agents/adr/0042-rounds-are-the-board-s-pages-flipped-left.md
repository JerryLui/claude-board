# 42. Rounds are the board's pages, flipped left and right

2026-08-07, amended for phones 2026-11-25

**Context:** why the vertical stack broke, and why per-artifact boards and full round titles were dropped: DESIGN.md. **Decision:** a thread keeps its single board and rounds become its pages — edge chevrons to flip, and a fixed `.round-pager-dock` of bare numerals dotting any round that still owes an answer. **Consequences:** the history rail is deleted, so the pager itself must keep a sent page read-only, and two rounds are never visible at once, so a question has to carry what it refers to.

**Amended for phones (2026-11-25):** at 560px wide or less the chevrons and the caption give way to one bottom pill, `‹ 11 / 14 ›`: this round of the board's rounds between two arrows that flip a round, a dot on the count while another round waits for an answer, and the numbers opening above the pill from a press on the count. The edge chevrons sat over the text at 44px on each side, the caption printed over the text above the pill, and the numerals wrapped past about six entries. Rejected: the numbers inside the pill with waiting rounds folded behind "…", which wraps again past about six entries. Cost: once the title scrolls away the round shows only as its count, and the open list lies over Send and Discuss until it closes.
