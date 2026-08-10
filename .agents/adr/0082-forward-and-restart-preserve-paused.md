# 82. Forward and Restart preserve paused

2026-08-10 · relates to 81

**Context:** `forwardTimer` and `restartTimer` both forced `paused: false`, deliberately — forwarding a paused timer advanced it *and* started it running — which made pause a state two neighbouring buttons could silently leave. **Decision:** both preserve it: forwarding a paused Timer lands paused at the start of the next phase, restarting a paused Timer re-mints the current phase and stays paused. Pause is left only by the control that owns it. **Consequences:** a paused Timer carries `remainingMs` rather than a `deadline`, so forward can no longer hand `settleBoundary` a doc pretending to have just expired and has to re-mint the next phase's remaining time itself; the rule holds on every surface, the Status item and the index page's widget alike, because it lives in the reducers rather than in either client.
