# 42. Rounds are the board's pages, flipped left and right

2026-08-07

**Context:** rounds stack vertically down one board, which a round that fills the viewport breaks outright. **Decision:** a thread keeps its single board and rounds become its pages — edge chevrons to flip, and a fixed `.round-pager-dock` of bare numerals dotting any round that still owes an answer. **Consequences:** the history rail is deleted, so the pager itself must keep a sent page read-only, and two rounds are never visible at once, so a question has to carry what it refers to. Why per-artifact boards and full round titles were dropped: DESIGN.md.
