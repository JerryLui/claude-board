# 71. The store is prunable by hand, and the promise not to prune it is dropped

2026-08-10 · relates to 70

**Context:** the store has never forgotten anything, `deleteBoard` was wired to no route, and three
places — `PROTOCOL.md`, `README.md` and `uninstall.sh`, which removes `pomodoro.json` by exact name
and never by glob — stated that review history is the user's and is not taken back. Declaring a
conversation boundary makes threads accumulate several times faster, and ADR 70 cannot shrink an
archive already written.

**Decision:** a prune deletes whole boards older than a window named at the call, plus any shared
asset no surviving page still references. It is fired only from the settings panel on the index,
deletes on one click without previewing, and runs at no other time — not on read, not at daemon
start, not on a schedule. The written promise is dropped rather than narrowed.

**Consequences:** the product no longer guarantees anything about how long a board survives, and
nothing argues on paper against a future automatic sweep. A flat age rule with no exemption can
delete a board holding a question never answered; that is tolerable only because nothing fires it
but a person. `uninstall.sh` still leaves the store alone.
