# 85. The tab carries one mark

2026-08-10 · relates to 84

**Context:** the index tab swapped its favicon to a rest mark on a break — a slate tile with two amber bars — which under ADR 84 now spells "paused" rather than "resting", so it needed either a new drawing or a third state alongside it. **Decision:** neither. The tab keeps one mark in every state and the swap is deleted, along with the rest tile, its palette entry and the index page's favicon-swapping half. Phase lives in the Status item, which is the surface built to carry it. **Consequences:** a glance at a browser tab no longer tells you the phase, which is the point — one surface owns that, so the two can never disagree; and a state added to the Timer later costs nothing in the tab.
