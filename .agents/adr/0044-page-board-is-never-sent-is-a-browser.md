# 44. "A page board is never sent" is a browser rule, not a daemon rule

2026-08-07 · narrowed by 45

**Context:** `handleSubmit` gates on the round number and its open status and never on what the round holds, so a request carrying the local write secret can submit an artifact round. **Decision:** the gate stays in the browser and the daemon keeps accepting any open round. **Consequences:** defence-in-one — it holds against every path a reviewer has, not against a caller that can post whatever board it likes anyway — and it keeps the one path that models an undelivered comment (`test/check-http.mjs`).
