# 8. The daemon owns the pomodoro clock

2026-08-04

**Context:** entry 1 put preferences in the browser and that held for every setting since, but a timer you lose by closing a tab is not a timer. **Decision:** the daemon persists the interval's absolute deadline, the cycle counter and the durations; the browser only renders a countdown from that deadline. **Consequences:** entry 1's principle now needs its boundary stated — a theme is a per-reader preference, a pomodoro is one fact about the human.
