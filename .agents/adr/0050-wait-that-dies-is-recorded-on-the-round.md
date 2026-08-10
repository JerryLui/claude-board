# 50. A wait that dies is recorded on the round

2026-08-08 · completes 45

**Context:** what a stamped-at-mint `awaited` flag cost, and why not a clock in every reader: DESIGN.md. **Decision:** the deadline passing clears `awaited` at `readBoard`, the one choke point every reader of a stored board goes through; `awaitDeadline` and `status` are left alone, so a lapsed round stays distinguishable from one never awaited. **Consequences:** every surface keeps its bare `awaited` read and becomes correct for free, and a lapsed round is not re-waitable, which is the price of the single stored fact.
