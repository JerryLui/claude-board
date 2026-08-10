# 8. The daemon owns the pomodoro clock

2026-08-04 · narrowed by 67

**Context:** entry 1 put preferences in the browser and that held for every setting since, but a timer you lose by closing a tab is not a timer. **Decision:** the daemon persists the interval's absolute deadline, the cycle counter and the durations; the browser only renders a countdown from that deadline. **Consequences:** entry 1's principle now needs its boundary stated — a theme is a per-reader preference, a pomodoro is one fact about the human. Persistence is not immortality: entry 67 narrows this by having the 05:00 rollover clear the timer as well as the cycle, so a paused interval does not survive the day it was paused in.
