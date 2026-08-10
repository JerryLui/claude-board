# 79. The status item polls at the widget's cadence

2026-08-10 · relates to 77; relates to 72

**Context:** the status item is a second process with no stream of its own, and the index widget it mirrors already polls the daemon every fifteen seconds and ticks locally every second, while the acceptance criterion asks the two surfaces to agree within one second. **Decision:** the item polls on that same fifteen-second tick and runs the same one-second local countdown, rather than opening an SSE connection into the daemon, so both surfaces derive the same remaining time from the same deadline. **Consequences:** the two agree while an interval runs but not straight after a control press on the other surface, which can take up to one tick to cross — one-directional per press, since the item re-polls immediately after its own actions — and narrowing that means an SSE client in Objective-C or a poll fast enough to be a different decision about load.
