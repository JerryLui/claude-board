# 47. The wait is 40 minutes, for every round, and the page shows what is left

2026-08-07

**Context:** two hours was set when nothing on the page said a clock was running, and since `ask` is the shim's only tool, nothing can read a board after its wait dies. **Decision:** the default wait drops to 40 minutes for every round shape, and the board shows the time left on the open round. **Consequences:** a review longer than 40 minutes has to be sent in parts, and the countdown is chrome the reviewer must be able to ignore.
